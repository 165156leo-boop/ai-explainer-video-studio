#!/usr/bin/env python3
"""Crop approved Doubao images to a composition-safe 16:9 frame.

The script is image-only. It never modifies the original downloaded image and
does not process video. Every derived image receives an `.ai.json` provenance
sidecar that points back to the unchanged original.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
from typing import Iterable


IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Crop the safe area from an approved Doubao image, resize "
            "it to 16:9, keep the source untouched, and write an AI provenance sidecar."
        )
    )
    parser.add_argument("input", type=Path, help="Approved original image or directory")
    parser.add_argument("output", type=Path, help="Derived image file or directory")
    parser.add_argument(
        "--crop-mode",
        choices=("minimal-bottom", "uniform"),
        default="minimal-bottom",
        help=(
            "Crop strategy. minimal-bottom keeps the top edge, removes at least "
            "the requested bottom inset, and crops the sides symmetrically to 16:9; "
            "uniform removes a percentage from every edge. Default: minimal-bottom"
        ),
    )
    parser.add_argument(
        "--bottom-inset-pixels",
        type=int,
        default=106,
        help="Minimum bottom inset used by minimal-bottom; default: 106",
    )
    parser.add_argument(
        "--margin-percent",
        type=float,
        default=7.0,
        help="Reserved margin removed from every edge in uniform mode; default: 7",
    )
    parser.add_argument("--width", type=int, default=1920, help="Output width")
    parser.add_argument("--height", type=int, default=1080, help="Output height")
    parser.add_argument(
        "--recursive", action="store_true", help="Process image subdirectories"
    )
    parser.add_argument(
        "--overwrite", action="store_true", help="Replace an existing derived image"
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def is_supported_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTENSIONS


def collect_inputs(source: Path, recursive: bool) -> Iterable[tuple[Path, Path]]:
    if source.is_file():
        if not is_supported_image(source):
            raise ValueError(f"Unsupported image type: {source}")
        yield source, Path(source.name)
        return

    if not source.is_dir():
        raise FileNotFoundError(f"Input does not exist: {source}")

    iterator = source.rglob("*") if recursive else source.glob("*")
    for item in sorted(iterator):
        if item.is_file() and is_supported_image(item):
            yield item, item.relative_to(source)


def largest_even_target_crop(
    max_width: int,
    max_height: int,
    target_width: int,
    target_height: int,
) -> tuple[int, int]:
    """Return the largest even dimensions at the exact target ratio."""
    if target_width <= 0 or target_height <= 0:
        raise ValueError("Output width and height must be positive")
    if max_width <= 0 or max_height <= 0:
        raise ValueError("No image area remains after the requested inset")

    divisor = math.gcd(target_width, target_height)
    ratio_width = target_width // divisor
    ratio_height = target_height // divisor
    scale = min(max_width // ratio_width, max_height // ratio_height)

    while scale > 0:
        crop_width = ratio_width * scale
        crop_height = ratio_height * scale
        if crop_width % 2 == crop_height % 2 == 0:
            break
        scale -= 1
    else:
        raise ValueError("Input is too small for the requested crop and aspect ratio")

    return crop_width, crop_height


def crop_box_uniform(
    source_width: int,
    source_height: int,
    margin_fraction: float,
    target_width: int,
    target_height: int,
) -> tuple[int, int, int, int]:
    """Return a centered crop box after reserving the same fraction per edge."""
    if not 0 <= margin_fraction < 0.25:
        raise ValueError("margin-percent must be at least 0 and less than 25")

    max_width = int(source_width * (1 - 2 * margin_fraction))
    max_height = int(source_height * (1 - 2 * margin_fraction))
    crop_width, crop_height = largest_even_target_crop(
        max_width, max_height, target_width, target_height
    )

    left = (source_width - crop_width) // 2
    top = (source_height - crop_height) // 2
    return left, top, left + crop_width, top + crop_height


def crop_box_minimal_bottom(
    source_width: int,
    source_height: int,
    bottom_inset_pixels: int,
    target_width: int,
    target_height: int,
) -> tuple[int, int, int, int]:
    """Keep the top edge and take the largest centered-width target-ratio crop."""
    if bottom_inset_pixels < 0:
        raise ValueError("bottom-inset-pixels must be at least 0")
    if bottom_inset_pixels >= source_height:
        raise ValueError("bottom-inset-pixels must be smaller than image height")

    crop_width, crop_height = largest_even_target_crop(
        source_width,
        source_height - bottom_inset_pixels,
        target_width,
        target_height,
    )
    left = (source_width - crop_width) // 2
    top = 0
    return left, top, left + crop_width, crop_height


def save_image(
    source: Path,
    output: Path,
    box: tuple[int, int, int, int],
    size: tuple[int, int],
) -> None:
    try:
        from PIL import Image, ImageOps
    except ImportError as exc:
        raise RuntimeError(
            "Pillow is required. Install it with: python -m pip install Pillow"
        ) from exc

    with Image.open(source) as original:
        image = ImageOps.exif_transpose(original)
        icc_profile = image.info.get("icc_profile")
        exif = image.getexif()
        derived = image.crop(box).resize(size, Image.Resampling.LANCZOS)
        output.parent.mkdir(parents=True, exist_ok=True)

        save_options: dict[str, object] = {}
        if icc_profile:
            save_options["icc_profile"] = icc_profile
        if exif:
            save_options["exif"] = exif.tobytes()
        if output.suffix.lower() in {".jpg", ".jpeg"}:
            if derived.mode not in {"RGB", "L"}:
                derived = derived.convert("RGB")
            save_options.update(quality=95, subsampling=0, optimize=True)
        elif output.suffix.lower() == ".png":
            save_options["compress_level"] = 6
        derived.save(output, **save_options)


def write_sidecar(
    source: Path,
    output: Path,
    source_size: tuple[int, int],
    output_size: tuple[int, int],
    box: tuple[int, int, int, int],
    crop_mode: str,
    margin_percent: float,
    bottom_inset_pixels: int,
) -> None:
    payload = {
        "ai_generated": True,
        "source_platform": "豆包",
        "unchanged_original": str(source.resolve()),
        "source_sha256": sha256(source),
        "derived_file": str(output.resolve()),
        "media_kind": "image",
        "processing": "center_safe_area_crop_and_resize",
        "source_size": {"width": source_size[0], "height": source_size[1]},
        "crop_box": {
            "left": box[0],
            "top": box[1],
            "right": box[2],
            "bottom": box[3],
        },
        "crop_strategy": crop_mode,
        "requested_margin_percent_per_edge": (
            margin_percent if crop_mode == "uniform" else None
        ),
        "requested_minimum_bottom_inset_pixels": (
            bottom_inset_pixels if crop_mode == "minimal-bottom" else None
        ),
        "output_size": {"width": output_size[0], "height": output_size[1]},
        "agent_scope": {
            "image_crop_only": True,
            "image_content_review": "completed_by_user_in_doubao_before_download",
            "video_processing": False,
        },
    }
    sidecar = output.with_suffix(output.suffix + ".ai.json")
    sidecar.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    args = parse_args()
    source_root = args.input.resolve()
    output_root = args.output.resolve()
    output_size = (args.width, args.height)

    items = list(collect_inputs(source_root, args.recursive))
    if not items:
        raise RuntimeError("No supported image files found")

    source_is_file = source_root.is_file()
    for source, relative in items:
        output = output_root if source_is_file else output_root / relative
        if source.resolve() == output.resolve():
            raise ValueError("Input and output paths must be different")
        if output.exists() and not args.overwrite:
            raise FileExistsError(f"Output already exists: {output}")

        try:
            from PIL import Image, ImageOps
        except ImportError as exc:
            raise RuntimeError("Pillow is required for image processing") from exc
        with Image.open(source) as original:
            image = ImageOps.exif_transpose(original)
            source_size = image.size

        if args.crop_mode == "minimal-bottom":
            box = crop_box_minimal_bottom(
                *source_size, args.bottom_inset_pixels, *output_size
            )
        else:
            margin_fraction = args.margin_percent / 100.0
            box = crop_box_uniform(
                *source_size, margin_fraction, *output_size
            )
        save_image(source, output, box, output_size)
        write_sidecar(
            source,
            output,
            source_size,
            output_size,
            box,
            args.crop_mode,
            args.margin_percent,
            args.bottom_inset_pixels,
        )
        print(
            f"OK {source.name} [{args.crop_mode}]: "
            f"{source_size[0]}x{source_size[1]} -> "
            f"crop {box} -> {output_size[0]}x{output_size[1]}"
        )

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, FileExistsError, RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
