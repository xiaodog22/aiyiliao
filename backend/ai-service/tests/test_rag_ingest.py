"""RAG 入库 pipeline 测试（2026-10-22 新增）。

锁定四件事：
1. **幂等**：point id = uuid5(doc_id::chunk_id)，同一内容跑两次，Qdrant 点数不翻倍；
2. **元数据**：source/doc_id/chunk_id/version/dept/scene/permission/ingested_at 齐全，
   且同时具备 rag.py 读取所需的 documentId/chunkId/content；
3. **失败可重跑**：embedding 或 upsert 失败只记账不中断，重跑覆盖同一批 id；重试用指数退避；
4. **安全默认**：不带 `--apply` 只打印计划（dry-run），非本机 Qdrant 必须 `--allow-remote`；
   日志只留 20 字预览，不落全文。
"""

from __future__ import annotations

import importlib.util
import io
import json
import re
import sys
from contextlib import redirect_stdout
from pathlib import Path

import pytest

SERVICE_DIR = Path(__file__).resolve().parent.parent
_SPEC = importlib.util.spec_from_file_location("rag_ingest", SERVICE_DIR / "scripts" / "rag_ingest.py")
R = importlib.util.module_from_spec(_SPEC)
sys.modules["rag_ingest"] = R          # dataclass 需要模块已注册，否则 __module__ 查不到
_SPEC.loader.exec_module(R)

ARTICLES = [{
    "id": "doc-a",
    "title": "测试文章 A",
    "category": "慢病管理",
    "source": "测试来源",
    "publishedAt": "2026-10-01",
    "sections": [
        {"h": "一、怎么量", "p": ["坐下安静休息 5 分钟再量。", "袖带与心脏同高。"]},
        {"h": "二、怎么记", "p": ["把每次的收缩压和舒张压记下来。"]},
    ],
}]


class FakeQdrant:
    """内存版 Qdrant：upsert 覆盖同 id，delete_by_filter 支持 must / must_not。"""

    def __init__(self, *, fail_upserts: int = 0) -> None:
        self.store: dict[str, dict] = {}
        self.fail_upserts = fail_upserts
        self.upsert_calls = 0
        self.delete_calls = 0

    def upsert(self, points):
        self.upsert_calls += 1
        if self.fail_upserts > 0:
            self.fail_upserts -= 1
            raise RuntimeError("模拟 503")
        for point in points:
            self.store[point["id"]] = point

    def delete_by_filter(self, must, must_not=None):
        self.delete_calls += 1
        doomed = [
            pid for pid, point in self.store.items()
            if self._match(point["payload"], must) and not self._match(point["payload"], must_not or [])
        ]
        for pid in doomed:
            self.store.pop(pid, None)

    @staticmethod
    def _match(payload: dict, conditions) -> bool:
        for cond in conditions:
            key, value = cond["key"], cond["match"]["value"]
            if payload.get(key) != value:
                return False
        return True

    def count(self):
        return len(self.store)


def _chunks(max_chars: int = 400):
    chunks = []
    for article in ARTICLES:
        chunks.extend(R.build_chunks(article, max_chars=max_chars))
    return chunks


def _embed(_text: str) -> list[float]:
    return [0.1, 0.2, 0.3]


# ---------------------------------------------------------------- 幂等
def test_point_ids_are_stable_across_runs():
    first = [c.point_id for c in _chunks()]
    second = [c.point_id for c in _chunks()]
    assert first == second, "同一 (doc_id, chunk_id) 必须得到同一个 point id"
    assert len(set(first)) == len(first), "id 不得重复"


def test_reingest_does_not_duplicate_points():
    qdrant = FakeQdrant()
    chunks = _chunks()

    stats1 = R.ingest(chunks, qdrant=qdrant, embed=_embed, version="kb-test", base_delay=0)
    stats2 = R.ingest(chunks, qdrant=qdrant, embed=_embed, version="kb-test", base_delay=0)

    assert stats1.upserted == stats2.upserted == len(chunks)
    assert qdrant.count() == len(chunks), f"重复入库后点数翻倍：{qdrant.count()} != {len(chunks)}"
    assert stats1.failed == stats2.failed == []


def test_old_version_points_are_purged_on_reingest():
    qdrant = FakeQdrant()
    chunks = _chunks()
    R.ingest(chunks, qdrant=qdrant, embed=_embed, version="kb-old", base_delay=0)
    assert qdrant.count() == len(chunks)

    R.ingest(chunks, qdrant=qdrant, embed=_embed, version="kb-new", base_delay=0)

    versions = {point["payload"]["version"] for point in qdrant.store.values()}
    assert versions == {"kb-new"}, f"旧版本残留：{versions}"
    assert qdrant.count() == len(chunks), "新旧版本应替换而非叠加"


# ---------------------------------------------------------------- 元数据
def test_payload_has_required_metadata():
    chunk = _chunks()[0]
    payload = R.build_payload(chunk, version="kb-test", ingested_at="2026-10-22T12:00:00Z")

    for key in ("source", "doc_id", "chunk_id", "version", "dept", "scene", "permission", "ingested_at"):
        assert key in payload, f"缺元数据字段 {key}"
    assert payload["doc_id"] == "doc-a" and payload["chunk_id"] == "c01"
    assert payload["source"] == "测试来源"
    assert payload["scene"] == "慢病管理"
    assert isinstance(payload["permission"], list) and payload["permission"] == ["public"]
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", payload["ingested_at"])
    # 检索侧读取字段（rag.py 用 camelCase）
    assert payload["documentId"] == "doc-a" and payload["chunkId"] == "c01"
    assert payload["content"] and payload["title"] == "测试文章 A"
    assert payload["content_hash"] and payload["content_len"] == len(payload["content"])


def test_section_heading_goes_into_indexed_text():
    chunk = _chunks()[0]
    assert chunk.text.startswith("一、怎么量"), "索引文本应带小节标题，便于召回"


# ---------------------------------------------------------------- 重试 / 可重跑
def test_upsert_retries_then_succeeds():
    qdrant = FakeQdrant(fail_upserts=1)
    stats = R.ingest(_chunks(), qdrant=qdrant, embed=_embed, version="kb-test",
                     max_retries=3, base_delay=0)

    assert stats.failed == [], f"一次瞬时失败应被重试消化：{stats.failed}"
    assert stats.retries >= 1, "应记录重试次数"
    assert qdrant.count() == len(_chunks())


def test_embed_failure_is_recorded_and_rerun_repairs():
    chunks = _chunks()
    bad = chunks[0].chunk_id

    def flaky_embed(text: str) -> list[float]:
        if bad in text or text.startswith("一、怎么量"):
            raise RuntimeError("embedding 失败")
        return [0.1, 0.2, 0.3]

    qdrant = FakeQdrant()
    stats = R.ingest(chunks, qdrant=qdrant, embed=flaky_embed, version="kb-test",
                     max_retries=2, base_delay=0, purge_stale=False)

    assert stats.failed and stats.failed[0].startswith("doc-a/c01:embed:"), stats.failed
    assert qdrant.count() == len(chunks) - 1

    # 重跑（embedding 恢复）：补齐缺失点，且不重复
    fixed = R.ingest(chunks, qdrant=qdrant, embed=_embed, version="kb-test", base_delay=0)
    assert fixed.failed == []
    assert qdrant.count() == len(chunks), "重跑后点数应恰好等于片段数"


def test_batch_size_and_limit():
    chunks = _chunks()
    qdrant = FakeQdrant()
    stats = R.ingest(chunks[:2], qdrant=qdrant, embed=_embed, version="kb-test",
                     batch_size=1, base_delay=0)
    assert stats.chunks == 2 and stats.batches == 2, "batch_size=1 时应分两批"


# ---------------------------------------------------------------- 安全默认 / dry-run
def _run(argv) -> tuple[int, str]:
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        code = R.main(argv)
    return code, buffer.getvalue()


def test_dry_run_prints_plan_without_writing(tmp_path):
    source = tmp_path / "articles.json"
    source.write_text(json.dumps({"articles": ARTICLES}, ensure_ascii=False), encoding="utf-8")

    code, out = _run(["--input", str(source), "--version", "kb-test", "--json"])

    assert code == 0
    report = json.loads(out)
    assert report["docs"] == 1 and report["chunks"] == 2
    assert report["version"] == "kb-test"
    assert set(report["sample"]) >= {"id", "doc_id", "chunk_id", "version", "permission", "preview"}
    # 日志脱敏：只给 20 字预览（截断），不出现完整片段
    assert "袖带与心脏同高" not in out, "预览不得包含完整正文（应被截断）"
    assert report["sample"]["preview"].endswith("…"), "预览必须以省略号收口"
    assert len(report["sample"]["preview"]) <= R.PREVIEW_CHARS + 1


def test_default_is_dry_run_even_without_flag(tmp_path):
    source = tmp_path / "articles.json"
    source.write_text(json.dumps(ARTICLES, ensure_ascii=False), encoding="utf-8")

    code, out = _run(["--input", str(source)])

    assert code == 0
    assert "dry-run" in out and "加 --apply 才会写入" in out


def test_remote_qdrant_requires_explicit_flag(tmp_path):
    source = tmp_path / "articles.json"
    source.write_text(json.dumps(ARTICLES, ensure_ascii=False), encoding="utf-8")

    code, _ = _run([
        "--input", str(source), "--apply",
        "--qdrant-url", "http://10.20.30.40:6333",
    ])

    assert code == 2, "非本机 Qdrant 且未 --allow-remote 时必须拒绝（防误写生产）"


def test_delete_version_dry_run_is_safe():
    code, out = _run(["--input", "unused.json", "--delete-version", "kb-old"])
    # --delete-version 分支不读输入文件，只提示 dry-run
    assert code == 0
    assert "dry-run" in out and "kb-old" in out


def test_delete_version_does_not_require_input_source():
    """回归：--delete-version 之前被 argparse 互斥组 required=True 挡住（exit=2，回滚不可用）。"""
    code, out = _run(["--delete-version", "kb-old"])
    assert code == 0, "回滚模式不应要求 --from-kb/--input"
    assert "kb-old" in out and "dry-run" in out


def test_missing_input_source_is_rejected():
    code, _ = _run(["--apply"])
    assert code == 2, "既没有输入源也不是回滚模式时必须报错退出"


# ---------------------------------------------------------------- CLI 端到端（本地桩）
def _start_stub():
    """起本地桩（Qdrant 子集 + Ollama embedding），返回 (base_url, shutdown)。"""
    import importlib.util
    import threading
    from http.server import ThreadingHTTPServer

    stub_path = SERVICE_DIR / "tools" / "stub-qdrant-ollama.py"
    spec = importlib.util.spec_from_file_location("stub_qdrant_ollama", stub_path)
    stub = importlib.util.module_from_spec(spec)
    sys.modules["stub_qdrant_ollama"] = stub
    spec.loader.exec_module(stub)

    server = ThreadingHTTPServer(("127.0.0.1", 0), stub.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address[0], server.server_address[1]
    return f"http://{host}:{port}", server.shutdown


def test_cli_end_to_end_idempotent_and_rollback(tmp_path):
    """真实 HTTP 链路：入库 → 重跑幂等 → 升版本清旧 → 按 version 回滚。"""
    import httpx

    base_url, shutdown = _start_stub()
    try:
        source = tmp_path / "articles.json"
        source.write_text(json.dumps({"articles": ARTICLES}, ensure_ascii=False), encoding="utf-8")
        common = ["--input", str(source), "--collection", "kb_test",
                  "--qdrant-url", base_url, "--ollama-url", base_url]

        code, out = _run(common + ["--apply", "--version", "kb-a"])
        assert code == 0, out
        count = httpx.get(f"{base_url}/collections/kb_test/points/count").json()["result"]["count"]
        assert count == 2, f"首次入库点数应为 2，实际 {count}"

        # 幂等：同版本重跑，点数不翻倍
        code, out = _run(common + ["--apply", "--version", "kb-a"])
        assert code == 0, out
        count = httpx.get(f"{base_url}/collections/kb_test/points/count").json()["result"]["count"]
        assert count == 2, f"重复入库后点数翻倍：{count}"

        # 升版本：旧版本点应被清掉，只剩新版本
        code, out = _run(common + ["--apply", "--version", "kb-b"])
        assert code == 0, out
        dump = httpx.get(f"{base_url}/_dump").json()
        versions = {p["payload"]["version"] for p in dump["points"]}
        assert versions == {"kb-b"}, f"旧版本残留：{versions}"
        assert dump["count"] == 2

        # 回滚：按 version 删除后归零
        code, out = _run(["--delete-version", "kb-b", "--collection", "kb_test",
                          "--qdrant-url", base_url, "--apply"])
        assert code == 0, out
        count = httpx.get(f"{base_url}/collections/kb_test/points/count").json()["result"]["count"]
        assert count == 0, f"回滚后点数应归零，实际 {count}"
    finally:
        shutdown()


# ---------------------------------------------------------------- 切片
def test_long_section_is_split_by_paragraphs():
    article = {
        "id": "doc-long",
        "title": "长文",
        "sections": [{"h": "长小节", "p": ["甲" * 120, "乙" * 120, "丙" * 120]}],
    }
    chunks = R.build_chunks(article, max_chars=150)
    assert len(chunks) >= 3, f"超长小节应继续拆分，实际 {len(chunks)}"
    assert all(len(c.content) <= 150 for c in chunks)


def test_article_without_sections_uses_content():
    chunks = R.build_chunks({"id": "doc-x", "title": "无小节", "content": "第一段\n第二段"})
    assert len(chunks) == 1 and "第一段" in chunks[0].content
