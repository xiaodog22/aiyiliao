"""公共卫生：传染病上报与慢病随访任务。"""

from __future__ import annotations

from datetime import datetime

from .. import db, security
from ..errors import conflict, not_found
from .common import as_str


def list_tasks(ctx):
    where, params = ["1=1"], []
    if ctx.q("status"):
        where.append("t.status=?")
        params.append(ctx.q("status"))
    if ctx.q("type"):
        where.append("t.type=?")
        params.append(ctx.q("type"))
    rows = db.query(
        "SELECT t.*, p.name AS patient_name, p.mrn AS patient_mrn, p.phone_mask, "
        "s.name AS done_by_name FROM ph_tasks t JOIN patients p ON p.id=t.patient_id "
        "LEFT JOIN staff s ON s.id=t.done_by WHERE " + " AND ".join(where) +
        " ORDER BY t.id DESC LIMIT 300", tuple(params))
    now = datetime.now()
    result = []
    for r in rows:
        overdue = False
        if r["status"] == "OPEN" and r["due_at"]:
            try:
                overdue = datetime.strptime(r["due_at"], "%Y-%m-%d %H:%M:%S") < now
            except ValueError:
                overdue = False
        result.append({
            "id": r["id"], "taskNo": r["task_no"], "type": r["type"],
            "patientName": security.mask_name(r["patient_name"]), "patientMrn": r["patient_mrn"],
            "patientId": r["patient_id"],
            "phoneMask": r["phone_mask"], "title": r["title"], "detail": r["detail"],
            "dueAt": r["due_at"], "status": r["status"], "overdue": overdue,
            "doneBy": r["done_by_name"], "doneAt": r["done_at"], "createdAt": r["created_at"],
        })
    return result


def complete(ctx):
    task_id = int(ctx.params["id"])
    note = as_str(ctx.body, "note", max_len=500)
    with db.tx() as con:
        row = con.execute("SELECT * FROM ph_tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise not_found("任务不存在")
        if row["status"] != "OPEN":
            raise conflict("任务已完成", "STATE_CONFLICT")
        con.execute("UPDATE ph_tasks SET status='DONE', done_by=?, done_at=? WHERE id=?",
                    (ctx.user.get("staff_id"), db.now_str(), task_id))
        security.audit(con, ctx.user, "PH_COMPLETE", "ph_task", task_id,
                       f"note={note}", "OK", ctx.ip)
    return {"id": task_id, "status": "DONE"}


def register(router):
    router.add("GET", r"/api/v1/ph-tasks", list_tasks, perm="ph.read")
    router.add("POST", r"/api/v1/ph-tasks/(?P<id>\d+)/complete", complete, perm="ph.complete")
