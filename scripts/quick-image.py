#!/usr/bin/env python3
"""Bounded, offline thumbnail encoder. Input: image bytes on stdin. Output: JSON.

Resize calculation adapted from DDDFXYqiming/dsh-vision-skill scripts/vision.py,
commit ad4d35f4ecfcf2713ac92c361e5e5f0ec096305b (MIT).
See THIRD_PARTY_LICENSES/dsh-vision-skill-MIT.txt for copyright and license.
Changes: never upscale, no grid rounding, hard pixel limit, JPEG thumbnail only,
stdin bytes instead of filesystem access, no provider/network/credential code.
"""
import argparse
import base64
import io
import json
import math
import sys
import warnings


def quick_size(height, width, max_pixels):
    """Adapted proportional shrink; floor preserves a strict total-pixel budget."""
    if height * width <= max_pixels:
        return height, width
    scale = math.sqrt(max_pixels / (height * width))
    height, width = max(1, int(height * scale)), max(1, int(width * scale))
    # Extremely long images can have one floored dimension clamped back to one.
    if height * width > max_pixels:
        if height > width:
            height = max(1, max_pixels // width)
        else:
            width = max(1, max_pixels // height)
    return height, width


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--max-pixels', type=int, default=512 * 512)
    args = parser.parse_args()
    budget = max(4096, min(512 * 512, args.max_pixels))
    try:
        from PIL import Image, ImageOps
    except ImportError:
        print('Pillow is not installed', file=sys.stderr)
        return 3
    Image.MAX_IMAGE_PIXELS = 40_000_000
    warnings.simplefilter('error', Image.DecompressionBombWarning)
    raw = sys.stdin.buffer.read(20 * 1024 * 1024 + 1)
    if not raw or len(raw) > 20 * 1024 * 1024:
        return 2
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            if opened.format not in ('PNG', 'JPEG', 'WEBP', 'GIF'):
                return 2
            if opened.width * opened.height > 40_000_000:
                return 2
            opened.seek(0)
            image = ImageOps.exif_transpose(opened)
            original = [image.width, image.height]
            target_h, target_w = quick_size(image.height, image.width, budget)
            if (target_w, target_h) != image.size:
                image = image.resize((target_w, target_h), Image.Resampling.LANCZOS)
            if image.mode in ('RGBA', 'LA', 'P'):
                rgba = image.convert('RGBA')
                background = Image.new('RGB', rgba.size, 'white')
                background.paste(rgba, mask=rgba.getchannel('A'))
                image = background
            else:
                image = image.convert('RGB')
            result = io.BytesIO()
            image.save(result, format='JPEG', quality=72, optimize=True)
            print(json.dumps({
                'dataUrl': 'data:image/jpeg;base64,' + base64.b64encode(result.getvalue()).decode('ascii'),
                'width': image.width, 'height': image.height, 'original': original,
                'firstFrameOnly': getattr(opened, 'n_frames', 1) > 1,
            }))
        return 0
    except Exception:
        print('Image could not be decoded', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
