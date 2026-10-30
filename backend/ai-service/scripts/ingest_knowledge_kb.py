"""
健康科普知识库入库脚本（2026-10-22）

用途：
    把 miniprogram/utils/knowledge-kb.js 里的 7 篇图文 + 3 个视频切片，
    经 Ollama embedding 生成向量，写入 Qdrant health_kb collection。

前置：
    1. Ollama 在跑（默认 http://127.0.0.1:11434），且已 `ollama pull nomic-embed-text`
    2. Qdrant 在跑（默认 http://127.0.0.1:6333），无鉴权

用法：
    cd backend/ai-service
    .venv\\Scripts\\python.exe scripts\\ingest_knowledge_kb.py
    # 可选：--qdrant http://127.0.0.1:6333 --ollama http://127.0.0.1:11434 --model nomic-embed-text

切片策略：
    - 每篇文章的每个 section 作为一个 chunk（h + p[] 拼接）
    - 每个视频的每条 tip 作为一个 chunk
    - 元数据：documentId / chunkId / title / source / publishedAt / category / chunkType

幂等：
    - chunk 命名规则稳定（documentId_chunkIndex），重复跑 upsert 覆盖同 ID
    - 先检查 collection 是否存在；不存在则按向量维度创建（48 for nomic-embed-text）
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

# ---------------- 数据（从 knowledge-kb.js 同步；改 JS 后需手动同步本块） ----------------

ARTICLES = [
    {
        "id": "sleep-quality",
        "title": "如何改善睡眠质量？医生给出这5个建议",
        "category": "睡眠",
        "source": "呼吸内科",
        "publishedAt": "2026-10-10",
        "sections": [
            ("一、保持规律作息", "尽量每天在同一时间上床和起床，包括周末。规律的生物钟有助于提高睡眠质量。"),
            ("二、控制睡前使用电子设备", "睡前一小时避免手机、电脑等蓝光屏幕，可阅读纸质书籍或听轻音乐。"),
            ("三、营造舒适睡眠环境", "保持卧室安静、黑暗和适宜温度，枕头高度以一拳为宜。"),
            ("四、白天适度运动", "每天快走或做操 30 分钟，微微出汗即可；但睡前两小时内避免剧烈运动。"),
            ("五、午休不宜过长", "午睡控制在 30 分钟以内，下午 3 点后不再补觉，以免影响夜间入睡。"),
        ],
    },
    {
        "id": "bp-daily",
        "title": "高血压患者的一天：这 5 个时间点要留意",
        "category": "慢病管理",
        "source": "院内宣传科",
        "publishedAt": "2026-09-08",
        "sections": [
            ("06:30 起床后", "起床别猛坐起，先在床上躺 30 秒、坐 30 秒再站起来。服药前测一次血压：先静坐 5 分钟，手臂与心脏同高。"),
            ("08:00 吃降压药", "固定时间吃，比如每天早上 7 点，和吃饭先后关系不大，关键是每天都一样。漏服了不要补双倍剂量，按原来的量继续吃。"),
            ("12:00 午饭", "全天盐控制在 5 克以内：一啤酒瓶盖大约是 6 克。少喝咸汤、少吃咸菜腊味和加工肉，这些是隐形盐的大头。"),
            ("16:00 运动", "快走 30 分钟左右、微微出汗即可，避开清晨血压最高的时段。血压很高（如 ≥180/110）或头晕胸闷时，当天先别运动。"),
            ("21:30 睡前", "再测一次血压并记录，顺手写下当天有没有漏服药。打呼噜严重、白天总犯困的人，建议查一次睡眠呼吸暂停。"),
        ],
    },
    {
        "id": "diabetes-diet",
        "title": "糖尿病饮食：把「一碗饭」换成「三个拳头」",
        "category": "慢病管理",
        "source": "院内宣传科",
        "publishedAt": "2026-09-05",
        "sections": [
            ("主食：一个拳头", "每餐主食控制在自己一个拳头大小，优先杂粮饭、荞麦面、燕麦。粥和烂面条升糖快，尽量换成干饭。"),
            ("蛋白质：一个拳头", "鱼、虾、鸡蛋、瘦肉、豆腐都算，每餐一个拳头的量。每周吃两次深海鱼，少吃香肠、培根这类加工肉。"),
            ("蔬菜：两个拳头", "绿叶菜为主，土豆、山药、南瓜、藕要算进主食里。蔬菜先吃，能明显减少餐后血糖的波动。"),
            ("加餐与水果", "两餐之间饿了，可以吃一小把坚果或半杯无糖酸奶。血糖稳定时，上下午各吃一次水果，每次约一个拳头大小（苹果、柚子、草莓）。"),
        ],
    },
    {
        "id": "cold-vs-flu",
        "title": "普通感冒还是流感？看这 4 点就够了",
        "category": "日常防护",
        "source": "院内宣传科",
        "publishedAt": "2026-09-02",
        "sections": [
            ("① 起病速度", "普通感冒是慢慢来的：先嗓子痒、再鼻塞，一两天才明显。流感常常一下子就倒下，几小时内就发冷、高热、浑身疼。"),
            ("② 发热程度", "普通感冒多为低热或不发热。流感常见 39℃ 以上，退热药效过后又反复。"),
            ("③ 全身症状", "普通感冒以鼻塞、流涕、打喷嚏为主，精神一般还好。流感以头痛、全身肌肉酸痛、乏力为主，不想动弹。"),
            ("④ 哪些人要早看", "65 岁以上老人、孕妇、有糖尿病/慢阻肺/心脏病的人，出现高热应尽快就医。如果出现呼吸急促、胸闷、意识模糊，直接到急诊。"),
        ],
    },
    {
        "id": "fall-prevent",
        "title": "家里这 6 个地方，最容易让老人跌倒",
        "category": "老年照护",
        "source": "院内宣传科",
        "publishedAt": "2026-08-28",
        "sections": [
            ("① 卫生间", "马桶旁、淋浴区装 L 形扶手，地面铺防滑垫，洗澡用沐浴椅。地面积水及时擦干，别用小块地毯。"),
            ("② 卧室床边", "床边装扶手或放稳固的椅子，起夜路线装感应小夜灯。按起床三步曲起身：躺 30 秒、坐 30 秒、站 30 秒。"),
            ("③ 楼梯", "两侧都要有扶手，台阶贴防滑条，楼梯口不要堆杂物。照明要亮，开关装在上下楼都够得着的位置。"),
            ("④ 客厅与走廊", "电线收进线槽，别横穿走道；茶几边角加防撞条。地面别打蜡，拖鞋换成后跟包住的防滑鞋。"),
            ("⑤ 厨房", "油、水洒了立刻擦；常用物品放在腰部高度，别踩凳子。需要爬高取物时用稳定的脚凳，并且有人在旁边。"),
            ("⑥ 门口与门槛", "高门槛加缓坡，门口换鞋处放一张稳固的凳子。雨雪天出门用防滑拐杖，鞋底花纹磨平要及时换。"),
        ],
    },
    {
        "id": "drug-safety",
        "title": "这些药别一起吃：常见用药冲突清单",
        "category": "用药安全",
        "source": "院内药剂科",
        "publishedAt": "2026-08-25",
        "sections": [
            ("抗凝药 + 止痛药", "华法林、利伐沙班等抗凝药，与阿司匹林、布洛芬同用会明显增加出血风险。必须同用时，医生会安排监测，别自己调整。"),
            ("止痛药 + 降压药", "布洛芬等非甾体止痛药会削弱降压效果，长期同用还可能损伤肾脏。关节痛需要长期止痛的老人，要主动告诉医生自己在吃降压药。"),
            ("他汀 + 西柚 / 部分抗真菌药", "西柚（葡萄柚）会影响他汀代谢，可能引起肌肉疼痛甚至肌溶解。吃他汀期间如果医生开了抗真菌药，记得确认能不能同用。"),
            ("复方感冒药 + 复方感冒药", "名字不同但成分可能重复（都含对乙酰氨基酚），叠加容易超过安全剂量。吃药前看成分表，重复成分只留一种。"),
            ("需要立刻就医的信号", "黑便或呕血、牙龈出血止不住、皮肤大片淤青。四肢肌肉酸痛无力、尿色变深（像浓茶）。"),
        ],
    },
    {
        "id": "report-read",
        "title": "体检报告上的「箭头」，哪些要当真",
        "category": "就医指导",
        "source": "院内体检中心",
        "publishedAt": "2026-08-20",
        "sections": [
            ("肝功能：转氨酶", "轻度升高（正常上限 2 倍以内）常见于熬夜、饮酒、感冒、脂肪肝。先调整生活方式，1 个月后复查；如果持续升高或伴黄疸，到消化内科就诊。"),
            ("血脂：看清是哪一项", "重点看低密度脂蛋白胆固醇（LDL-C），它和心梗、脑梗关系最直接。已经有冠心病、糖尿病的人，目标值比普通人更严，别只看有没有箭头。"),
            ("甲状腺结节", "报告一般会写 TI-RADS 分级：3 级及以下多为良性，按医生建议定期复查超声。4 级以上或结节短期内明显变大，需要到内分泌科/甲状腺外科进一步评估。"),
            ("血糖", "空腹血糖 6.1~7.0mmol/L 属于糖前期，先做饮食运动干预，3 个月复查。达到 7.0mmol/L 及以上，建议到内分泌科做确诊检查。"),
            ("肿瘤标志物", "轻度升高可见于炎症、吸烟、熬夜等很多情况，不等于肿瘤。明显升高或连续复查持续上升，才需要进一步做影像检查。"),
        ],
    },
]

VIDEOS = [
    {
        "id": "wash-hands",
        "title": "七步洗手法",
        "category": "日常防护",
        "source": "院内宣传科",
        "publishedAt": "2026-10-01",
        "tips": [
            "用流动水，先把手打湿再涂洗手液",
            "指缝、指尖、拇指、手腕最容易漏掉",
            "没有流动水时，用免洗手消毒液搓够 20 秒",
        ],
    },
    {
        "id": "measure-bp",
        "title": "在家量血压 4 个要点",
        "category": "慢病管理",
        "source": "院内宣传科",
        "publishedAt": "2026-10-01",
        "tips": [
            "固定每天同一时间测：起床后 1 小时内、晚饭前各一次",
            "坐着量，不要躺着量；量前 30 分钟别喝茶、别吸烟",
            "把每次的收缩压/舒张压记在纸上，复诊时带给医生",
        ],
    },
    {
        "id": "stand-up",
        "title": "起床三步曲（防跌倒）",
        "category": "老年照护",
        "source": "院内宣传科",
        "publishedAt": "2026-10-01",
        "tips": [
            "床头放一盏小夜灯，起夜别摸黑走",
            "床边、卫生间装扶手，地面保持干燥",
            "正在吃降压药、安眠药的老人，起床更要慢",
        ],
    },
]


# ---------------- HTTP 工具 ----------------

def _http_post(url: str, payload: dict, timeout: float = 30.0) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_put(url: str, payload: dict, timeout: float = 30.0) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_get(url: str, timeout: float = 10.0) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, {}


# ---------------- 业务流程 ----------------

def check_ollama(ollama_url: str, model: str) -> None:
    print(f"[1/4] 检查 Ollama embedding 模型：{ollama_url}  model={model}")
    status, tags = _http_get(f"{ollama_url.rstrip('/')}/api/tags")
    if status != 200:
        sys.exit(f"  ✗ Ollama 不可达（HTTP {status}）。请先启动 Ollama。")
    names = [m.get("name", "") for m in tags.get("models", [])]
    if not any(n.startswith(model) for n in names):
        sys.exit(f"  ✗ 模型 {model} 未安装。请先执行：ollama pull {model}\n  当前已装：{names}")
    print(f"  ✓ Ollama 可达，已装模型：{names}")


def get_embedding(ollama_url: str, model: str, text: str) -> list[float]:
    resp = _http_post(
        f"{ollama_url.rstrip('/')}/api/embeddings",
        {"model": model, "prompt": text},
    )
    vec = resp.get("embedding")
    if not vec:
        raise RuntimeError(f"embedding 返回空：{resp}")
    return vec


def ensure_collection(qdrant_url: str, collection: str, vector_dim: int) -> None:
    print(f"[2/4] 检查 Qdrant collection：{qdrant_url}  collection={collection}")
    status, _ = _http_get(f"{qdrant_url.rstrip('/')}/collections/{collection}")
    if status == 200:
        print(f"  ✓ collection 已存在，将 upsert（同 ID 覆盖）")
        return
    if status != 404:
        sys.exit(f"  ✗ 查询 collection 失败（HTTP {status}）")
    print(f"  → collection 不存在，创建（向量维度={vector_dim}）")
    _http_put(
        f"{qdrant_url.rstrip('/')}/collections/{collection}",
        {
            "vectors": {
                "size": vector_dim,
                "distance": "Cosine",
            }
        },
    )
    print(f"  ✓ collection 已创建")


def build_chunks() -> list[dict]:
    chunks = []
    for art in ARTICLES:
        for idx, (h, p) in enumerate(art["sections"]):
            chunks.append({
                "documentId": art["id"],
                "chunkId": f"{art['id']}_p{idx+1}",
                "content": f"【{h}】{p}",
                "title": art["title"],
                "source": art["source"],
                "publishedAt": art["publishedAt"],
                "category": art["category"],
                "chunkType": "article",
            })
    for vid in VIDEOS:
        for idx, tip in enumerate(vid["tips"]):
            chunks.append({
                "documentId": vid["id"],
                "chunkId": f"{vid['id']}_tip{idx+1}",
                "content": tip,
                "title": vid["title"],
                "source": vid["source"],
                "publishedAt": vid["publishedAt"],
                "category": vid["category"],
                "chunkType": "video_tip",
            })
    return chunks


def upsert_chunks(qdrant_url: str, collection: str, chunks: list[dict], ollama_url: str, model: str) -> None:
    print(f"[3/4] 切片 embedding + upsert（共 {len(chunks)} 条）")
    points = []
    for i, ch in enumerate(chunks, 1):
        vec = get_embedding(ollama_url, model, ch["content"])
        # 用 chunkId 的 hash 作为 uint64 point id（Qdrant 要求）
        import hashlib
        point_id = int(hashlib.sha256(ch["chunkId"].encode("utf-8")).hexdigest()[:16], 16)
        points.append({
            "id": point_id,
            "vector": vec,
            "payload": {
                "documentId": ch["documentId"],
                "chunkId": ch["chunkId"],
                "content": ch["content"],
                "title": ch["title"],
                "source": ch["source"],
                "publishedAt": ch["publishedAt"],
                "category": ch["category"],
                "chunkType": ch["chunkType"],
            },
        })
        print(f"  [{i}/{len(chunks)}] {ch['chunkId']}  ({len(ch['content'])} 字)")
        time.sleep(0.05)  # 礼貌限流

    print(f"[4/4] 批量 upsert 到 Qdrant")
    _http_put(
        f"{qdrant_url.rstrip('/')}/collections/{collection}/points?wait=true",
        {"points": points},
        timeout=60.0,
    )
    print(f"  ✓ 已写入 {len(points)} 个 points")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qdrant", default="http://127.0.0.1:6333")
    ap.add_argument("--ollama", default="http://127.0.0.1:11434")
    ap.add_argument("--model", default="nomic-embed-text")
    ap.add_argument("--collection", default="health_kb")
    args = ap.parse_args()

    print("=" * 60)
    print("健康科普知识库入库脚本")
    print("=" * 60)

    check_ollama(args.ollama, args.model)

    # 探测向量维度（用第一个 chunk 试跑）
    dim_probe = get_embedding(args.ollama, args.model, "维度探测")
    vector_dim = len(dim_probe)
    print(f"  向量维度：{vector_dim}")

    ensure_collection(args.qdrant, args.collection, vector_dim)

    chunks = build_chunks()
    upsert_chunks(args.qdrant, args.collection, chunks, args.ollama, args.model)

    print()
    print("=" * 60)
    print("✓ 入库完成。下一步：")
    print(f"  1. 确认 Qdrant 可达：{args.qdrant}")
    print(f"  2. 在 backend/deploy/env.local 打开：")
    print(f"     AI_RAG_ENABLED=true")
    print(f"     AI_QDRANT_URL={args.qdrant}")
    print(f"     AI_EMBEDDING_MODEL={args.model}")
    print(f"  3. 重启 ai-service：backend/deploy/restart.bat")
    print("=" * 60)


if __name__ == "__main__":
    main()
