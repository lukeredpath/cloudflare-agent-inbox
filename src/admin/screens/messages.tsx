import { useContext, useMemo, useState } from "preact/hooks";
import type { MessageListItem } from "../../worker/admin/types.ts";
import { useResource } from "../data.ts";
import { formatBytes, formatFull, formatWhen } from "../format.ts";
import { Icon } from "../icons.tsx";
import { OverviewContext } from "../overview-context.ts";
import { navigate, to } from "../router.ts";
import { Empty, LoadError, MessageFlags, PageHead, ProcessedPill, rowLink, TableSkeleton, UntrustedInline } from "../ui.tsx";

const STATUSES = [
  ["all", "All"],
  ["unprocessed", "Unprocessed"],
  ["processed", "Processed"],
] as const;

type SortKey = "received_at" | "size";

export function MessagesScreen({ lane, status }: { lane: string; status: string }) {
  const lanes = useContext(OverviewContext).data?.lanes ?? [];
  const current = STATUSES.some(([v]) => v === status) ? status : "all";
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "received_at", dir: -1 });

  const params = new URLSearchParams();
  if (lane) params.set("lane", lane);
  if (current !== "all") params.set("status", current);
  const { data, error, loading } = useResource<MessageListItem[]>(`/api/messages?${params}`);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (data ?? []).filter(
      (m) => !q || [m.id, m.untrusted_envelope_from, m.untrusted_subject ?? ""].some((s) => s.toLowerCase().includes(q)),
    );
    return matches.sort((a, b) => (a[sort.key] < b[sort.key] ? -1 : a[sort.key] > b[sort.key] ? 1 : 0) * sort.dir);
  }, [data, query, sort]);

  const sortButton = (key: SortKey, label: string) => (
    <button
      class="sort"
      type="button"
      aria-sort={sort.key === key ? (sort.dir > 0 ? "ascending" : "descending") : undefined}
      onClick={() => setSort(sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: -1 })}
    >
      {label}
    </button>
  );

  const filterTo = (next: { lane?: string; status?: string }) => navigate(to.messages({ lane, status: current, ...next }));

  return (
    <>
      <PageHead title="Messages" sub="Showing up to the most recent 100. Search runs over this loaded list only." />
      <section class="panel">
        <div class="toolbar" role="search">
          <label class="sr" for="mf-lane">
            Lane
          </label>
          <select class="select auto" id="mf-lane" value={lane} onChange={(e) => filterTo({ lane: e.currentTarget.value })}>
            <option value="">All lanes</option>
            {lanes.map((l) => (
              <option key={l.slug} value={l.slug}>
                {l.slug}
              </option>
            ))}
          </select>
          <div class="seg" role="group" aria-label="Processing status">
            {STATUSES.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={current === value} onClick={() => filterTo({ status: value })}>
                {label}
              </button>
            ))}
          </div>
          <div class="input-search grow">
            <Icon name="search" />
            <label class="sr" for="mf-q">
              Search loaded messages
            </label>
            <input class="input" id="mf-q" data-search type="search" placeholder="Search sender, subject, ID  /" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
          </div>
        </div>
        {error ? (
          <LoadError error={error} what="Messages" />
        ) : !data ? (
          <TableSkeleton rows={6} />
        ) : (
          <>
            <div class="table-wrap" aria-busy={loading}>
              <table class="table stack-sm">
                <thead>
                  <tr>
                    <th>{sortButton("received_at", "Received")}</th>
                    <th>Lane</th>
                    <th>Sender</th>
                    <th>Subject</th>
                    <th class="num">{sortButton("size", "Size")}</th>
                    <th class="num">Files</th>
                    <th>Flags</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((m) => (
                    <tr key={m.id} class="clickable" onClick={rowLink(to.message(m.id))}>
                      <td data-l="Received" class="nowrap" title={formatFull(m.received_at)}>
                        <a href={to.message(m.id)}>{formatWhen(m.received_at)}</a>
                      </td>
                      <td data-l="Lane" class="mono">
                        {m.lane}
                      </td>
                      <td data-l="Sender" class="cell-sender">
                        <UntrustedInline text={m.untrusted_envelope_from} truncate />
                      </td>
                      <td data-l="Subject" class="cell-subject">
                        <UntrustedInline text={m.untrusted_subject ?? "(no subject)"} truncate />
                      </td>
                      <td data-l="Size" class="num">
                        {formatBytes(m.size)}
                      </td>
                      <td data-l="Files" class="num">
                        {m.attachment_count || <span class="muted">0</span>}
                      </td>
                      <td data-l="Flags">
                        <MessageFlags message={m} />
                      </td>
                      <td data-l="Status">
                        <ProcessedPill processed={m.processed} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {shown.length === 0 &&
              (data.length === 0 && !query ? (
                <Empty icon="mail" title="No messages" text="Nothing matches these filters yet. Mail forwarded to a lane’s address appears here." tight />
              ) : (
                <Empty
                  icon="search"
                  title="No messages match"
                  text="Nothing in the loaded list matches these filters."
                  tight
                  action={
                    <button
                      class="btn"
                      type="button"
                      onClick={() => {
                        setQuery("");
                        navigate(to.messages());
                      }}
                    >
                      Clear filters
                    </button>
                  }
                />
              ))}
          </>
        )}
      </section>
    </>
  );
}
