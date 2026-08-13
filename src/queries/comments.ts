// CNT-05 — the read half of a deliverable's comment thread. Threaded on the
// task (workflows/comments.ts explains why), so this reads by task id and
// nothing narrower: whichever version of the file is current, the thread
// underneath it is the same one.

export type FileComment = {
  id: string;
  taskId: string;
  authorPersonId: string;
  authorName: string;
  body: string;
  createdAt: number;
};

type CommentRow = {
  id: string;
  task_id: string;
  author_person_id: string;
  author_name: string;
  body: string;
  created_at: number;
};

const toComment = (r: CommentRow): FileComment => ({
  id: r.id,
  taskId: r.task_id,
  authorPersonId: r.author_person_id,
  authorName: r.author_name,
  body: r.body,
  createdAt: r.created_at,
});

/** One deliverable's whole thread, oldest first — the order a conversation
 *  reads in. */
export async function commentsForTask(db: D1Database, taskId: string): Promise<FileComment[]> {
  const res = await db
    .prepare(
      `SELECT fc.id, fc.task_id, fc.author_person_id, pe.name AS author_name, fc.body, fc.created_at
         FROM file_comment fc
         JOIN person pe ON pe.id = fc.author_person_id
        WHERE fc.task_id = ?
        ORDER BY fc.created_at`
    )
    .bind(taskId)
    .all<CommentRow>();
  return (res.results ?? []).map(toComment);
}

/** The same, for a handful of tasks at once — a portal or a proposal reads
 *  several threads on one page. Capped like workflows/files.ts's own
 *  per-task reads: D1 takes a bounded number of statements in one batch. */
export async function commentsForTasks(
  db: D1Database,
  taskIds: string[]
): Promise<Map<string, FileComment[]>> {
  const out = new Map<string, FileComment[]>();
  const ids = taskIds.slice(0, 50);
  if (ids.length === 0) return out;
  const results = await db.batch<CommentRow>(
    ids.map((id) =>
      db
        .prepare(
          `SELECT fc.id, fc.task_id, fc.author_person_id, pe.name AS author_name, fc.body, fc.created_at
             FROM file_comment fc
             JOIN person pe ON pe.id = fc.author_person_id
            WHERE fc.task_id = ?
            ORDER BY fc.created_at`
        )
        .bind(id)
    )
  );
  ids.forEach((id, i) => {
    const rows = results[i]?.results ?? [];
    if (rows.length) out.set(id, rows.map(toComment));
  });
  return out;
}
