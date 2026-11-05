#!/usr/bin/env python3
"""把 site/index.html 发布到 GitHub Pages。

做法：不动 main、不切分支，直接调 Git Data API 建一个只含 index.html 的
gh-pages 分支，再把 Pages 源指过去。凭据从 `git credential fill` 读，
不落盘、不打印。

用法：
    python tools/publish-pages.py            # 发布当前 site/index.html
    python tools/publish-pages.py --no-wait  # 不等待构建结果
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

OWNER, REPO = "xiaodog22", "aiyiliao"
BRANCH = "gh-pages"
SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site", "index.html")
BASE = "https://api.github.com/repos/%s/%s" % (OWNER, REPO)
URL = "https://%s.github.io/%s/" % (OWNER, REPO)


def token():
    out = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True, text=True, timeout=30,
        env=dict(os.environ, GIT_TERMINAL_PROMPT="0"),
    ).stdout
    for line in out.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1]
    sys.exit("取不到 GitHub 凭据，先在本机登录一次 git")


TOKEN = token()


def api(path, method="GET", data=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "publish-pages",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, {"msg": e.read().decode()[:300]}


def main():
    wait = "--no-wait" not in sys.argv
    html = open(SITE, "rb").read()
    print("源文件 %.0f KB" % (len(html) / 1024))

    st, blob = api("/git/blobs", "POST", {"content": base64.b64encode(html).decode(), "encoding": "base64"})
    if st not in (200, 201):
        sys.exit("上传内容失败 %s %s" % (st, blob))
    st, empty = api("/git/blobs", "POST", {"content": "", "encoding": "base64"})
    if st not in (200, 201):
        sys.exit("上传 .nojekyll 失败 %s" % st)

    st, tree = api("/git/trees", "POST", {"tree": [
        {"path": "index.html", "mode": "100644", "type": "blob", "sha": blob["sha"]},
        {"path": ".nojekyll", "mode": "100644", "type": "blob", "sha": empty["sha"]},
    ]})
    if st not in (200, 201):
        sys.exit("建 tree 失败 %s %s" % (st, tree))

    st, cm = api("/git/commits", "POST", {
        "message": "site: 发布项目官网 %s" % time.strftime("%Y-%m-%d %H:%M"),
        "tree": tree["sha"],
    })
    if st not in (200, 201):
        sys.exit("建 commit 失败 %s %s" % (st, cm))

    st, ref = api("/git/refs", "POST", {"ref": "refs/heads/" + BRANCH, "sha": cm["sha"]})
    if st == 422:  # 分支已存在，直接快进
        st, ref = api("/git/refs/heads/" + BRANCH, "PATCH", {"sha": cm["sha"], "force": True})
    if st not in (200, 201):
        sys.exit("推送分支失败 %s %s" % (st, ref))
    print("分支 %s -> %s" % (BRANCH, cm["sha"][:8]))

    st, page = api("/pages", "PUT", {"source": {"branch": BRANCH, "path": "/"}})
    if st not in (200, 204):
        sys.exit("设置 Pages 源失败 %s %s" % (st, page))
    print("Pages 源已指向 %s /" % BRANCH)

    if wait:
        for i in range(30):
            st, b = api("/pages/builds/latest")
            s = b.get("status")
            if s in ("built", "errored"):
                print("构建 %s（%ds）" % (s, i * 5))
                break
            time.sleep(5)
    print("在线地址 " + URL)


if __name__ == "__main__":
    main()
