import { useMemo, useState } from "preact/hooks";
import type { RejectionView } from "../../worker/admin/types.ts";
import { useResource } from "../data.ts";
import { formatFull, formatWhen, reasonLabel } from "../format.ts";
import { Icon } from "../icons.tsx";
import { to } from "../router.ts";
import { Empty, LoadError, PageHead, Pill, TableSkeleton, Untrusted, UntrustedInline } from "../ui.tsx";

const BUCKETS = [
  ["all", "All"],
  ["probe", "Probes"],
  ["lane", "Lanes"],
] as const;

function Details({ r }: { r: RejectionView }) {
  const parts = [
    r.untrusted_header_from && `From header: ${r.untrusted_header_from}`,
    r.untrusted_detail && `Detail: ${r.untrusted_detail}`,
    r.untrusted_diagnostics && `Authentication headers:\n${r.untrusted_diagnostics}`,
  ].filter(Boolean);
  return <Untrusted text={parts.length ? parts.join("\n\n") : "Nothing more was recorded."} label="Diagnostics, contains values from the email, untrusted" />;
}

export function RejectionsScreen() {
  const { data, error } = useResource<RejectionView[]>("/api/rejections");
  const [bucket, setBucket] = useState<string>("all");
  const [reason, setReason] = useState("");
  const [query, setQuery] = useState("");
  const [diagnostics, setDiagnostics] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const reasons = useMemo(() => [...new Set((data ?? []).map((r) => r.reason))], [data]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? []).filter(
      (r) =>
        (bucket === "all" || r.bucket === bucket) &&
        (!reason || r.reason === reason) &&
        (!q || `${r.untrusted_envelope_from} ${r.untrusted_recipient_hint}`.toLowerCase().includes(q)),
    );
  }, [data, bucket, reason, query]);

  return (
    <>
      <PageHead
        title="Rejections"
        sub="Mail refused before it reached a lane. Probes are sent to addresses that do not exist; lane rejections failed a lane’s rules."
      />
      <section class="panel">
        <div class="toolbar" role="search">
          <div class="seg" role="group" aria-label="Bucket">
            {BUCKETS.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={bucket === value} onClick={() => setBucket(value)}>
                {label}
              </button>
            ))}
          </div>
          <label class="sr" for="rf-reason">
            Reason
          </label>
          <select class="select auto" id="rf-reason" value={reason} onChange={(e) => setReason(e.currentTarget.value)}>
            <option value="">All reasons</option>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {reasonLabel(r)}
              </option>
            ))}
          </select>
          <div class="input-search grow">
            <Icon name="search" />
            <label class="sr" for="rf-q">
              Search sender or recipient
            </label>
            <input class="input" id="rf-q" data-search type="search" placeholder="Sender or recipient  /" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
          </div>
          <label class="check">
            <input type="checkbox" checked={diagnostics} onChange={(e) => setDiagnostics(e.currentTarget.checked)} /> Diagnostics
          </label>
        </div>
        {error ? (
          <LoadError error={error} what="The rejection log" />
        ) : !data ? (
          <TableSkeleton rows={6} />
        ) : shown.length === 0 ? (
          <Empty
            icon="ban"
            title={data.length === 0 ? "No rejections" : "No rejections match"}
            text={data.length === 0 ? "Nothing has been refused in the retained log." : "Try another bucket or reason."}
            tight
          />
        ) : (
          <div class="table-wrap">
            <table class="table stack-sm">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Bucket</th>
                  <th>Reason</th>
                  <th>Sender</th>
                  <th>Recipient hint</th>
                  <th>
                    <span class="sr">Diagnostics</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <>
                    <tr key={r.id}>
                      <td data-l="When" class="nowrap" title={formatFull(r.received_at)}>
                        {formatWhen(r.received_at)}
                      </td>
                      <td data-l="Bucket">
                        {r.bucket === "probe" ? (
                          <Pill plain>Probe</Pill>
                        ) : (
                          <>
                            <Pill tone="info" plain>
                              Lane
                            </Pill>{" "}
                            {r.lane && (
                              <a class="mono" href={to.lane(r.lane)}>
                                {r.lane}
                              </a>
                            )}
                          </>
                        )}
                      </td>
                      <td data-l="Reason">{reasonLabel(r.reason)}</td>
                      <td data-l="Sender">
                        <UntrustedInline text={r.untrusted_envelope_from} truncate />
                      </td>
                      <td data-l="Recipient">
                        <UntrustedInline text={r.untrusted_recipient_hint} truncate />
                      </td>
                      <td class="num no-label">
                        {diagnostics && (
                          <button class="btn btn-sm" type="button" aria-expanded={Boolean(open[r.id])} onClick={() => setOpen({ ...open, [r.id]: !open[r.id] })}>
                            {open[r.id] ? "Hide" : "Details"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {diagnostics && open[r.id] && (
                      <tr key={`${r.id}-details`}>
                        <td colSpan={6} class="no-label">
                          <Details r={r} />
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
