# -*- coding: utf-8 -*-
"""M4 演练配套：以「脱离作业对象」的分离进程拉起网关（对抗任务树延迟回收）。

用法：python spawn_detached_gateway.py
成功标志：stdout 打印 launcher pid；随后由调用方另行探活。
"""

import os
import subprocess
import sys

GW = r"D:\asr_chaoshanhua\asr_chaoshanhua_V01\_V01\wechar\backend\edge-gateway"
PY = r"D:\asr_chaoshanhua\asr_chaoshanhua_V01\_V01\wechar\backend\ai-service\.venv\Scripts\python.exe"

DETACHED = 0x00000008 | 0x00000200 | 0x01000000  # DETACHED_PROCESS | NEW_PG | BREAKAWAY
CREATE_NO_WINDOW = 0x08000000

flags = DETACHED
try:
    p = subprocess.Popen(
        [PY, "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"],
        cwd=GW, creationflags=flags,
        stdout=open(os.path.join(GW, "..", "deploy", "logs", "gw-detached.log"), "ab"),
        stderr=open(os.path.join(GW, "..", "deploy", "logs", "gw-detached.err.log"), "ab"),
        stdin=subprocess.DEVNULL, close_fds=True,
    )
    print("launcher=" + str(p.pid))
except OSError as e:
    # 不允许 breakaway 时退回普通分离
    p = subprocess.Popen(
        [PY, "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"],
        cwd=GW, creationflags=CREATE_NO_WINDOW,
        stdout=open(os.path.join(GW, "..", "deploy", "logs", "gw-detached.log"), "ab"),
        stderr=open(os.path.join(GW, "..", "deploy", "logs", "gw-detached.err.log"), "ab"),
        stdin=subprocess.DEVNULL, close_fds=True,
    )
    print("launcher_no_breakaway=" + str(p.pid) + " warn=" + str(e))
sys.exit(0)
