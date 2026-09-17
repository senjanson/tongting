"""python -m tongting_asr 等同于 tongting-asr 命令。"""

import sys

from .cli import main

sys.exit(main())
