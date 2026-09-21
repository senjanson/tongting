"""Short-lived yt-dlp child. No browser cookies, config files, cache or persistent downloads."""

from __future__ import annotations

import json
import sys


class QuietLogger:
    def debug(self, *_args, **_kwargs):
        pass

    warning = debug
    error = debug


def main() -> int:
    from yt_dlp import YoutubeDL

    from .youtube import VIDEO_ID

    if len(sys.argv) != 3 or VIDEO_ID.fullmatch(sys.argv[1]) is None:
        return 2
    try:
        with YoutubeDL(
            {
                "quiet": True,
                "no_warnings": True,
                "logger": QuietLogger(),
                "cachedir": False,
                "skip_download": True,
                "noplaylist": True,
                "socket_timeout": 15,
                "retries": 1,
                "extractor_retries": 1,
                # MP4's indexed audio is cheaper to seek remotely than some WebM
                # tracks. Speech recognition resamples either format to 16 kHz.
                "format": "bestaudio[ext=m4a][protocol=https][has_drm!=true]/bestaudio[protocol=https][has_drm!=true]",
                "js_runtimes": {"node": {"path": sys.argv[2]}},
            }
        ) as downloader:
            info = downloader.extract_info(f"https://www.youtube.com/watch?v={sys.argv[1]}", download=False)
            if not isinstance(info, dict):
                return 1
            print(
                json.dumps(
                    {
                        "url": info.get("url"),
                        "duration": info.get("duration"),
                        "live": info.get("live_status") not in (None, "not_live"),
                        "drm": bool(info.get("has_drm")),
                        "availability": info.get("availability"),
                    }
                )
            )
    except Exception:
        # Neither signed media URLs nor extractor diagnostics are safe to echo.
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
