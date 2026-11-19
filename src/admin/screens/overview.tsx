import { useContext } from "preact/hooks";
import { setLaneStatus } from "../actions.ts";
import { Icon } from "../icons.tsx";
import { timeAgo, formatFull, plural } from "../format.ts";
import { OverviewContext } from "../overview-context.ts";
import { to } from "../router.ts";
import { Empty, LaneStatusPill, LoadError, PageHead, PageSkeleton, rowLink } from "../ui.tsx";

export function Overview() {
  const { data, error } = useContext(OverviewContext);
  if (error) return <LoadError error={error} what="The overview" />;
  if (!data) return <PageSkeleton />;

  const paused = data.lanes.filter((l) => l.status === "paused");
  const rejections = data.rejections_48h.probe + data.rejections_48h.lane;
  const items = data.transform_failures.length + paused.length + 1;
  const active = data.lanes.filter((l) => l.status === "active").length;

  return (
    <>
      <PageHead
        title="Overview"
        sub={`${plural(data.lanes.length, "lane")}, ${active} active.`}
        actions={
          <a class="btn btn-primary" href={to.newLane()}>
            <Icon name="plus" />
            New lane
          </a>
        }
      />
      {data.lanes.length === 0 ? (
        <section class="panel">
          <Empty
            icon="lane"
            title="No lanes yet"
            text="A lane gets its own address. Mail forwarded to that address is filed here for the agents you grant."
            action={
              <a class="btn btn-primary" href={to.newLane()}>
                <Icon name="plus" />
                Create the first lane
              </a>
            }
          />
        </section>
      ) : (
        <div class="stack">
          <section class="panel" aria-labelledby="attn-h">
            <div class="panel-head">
              <h2 id="attn-h">Needs attention</h2>
              <span class="meta">{plural(items, "item")}</span>
            </div>
            <ul class="attn">
              {data.transform_failures.map((f) => (
                <li key={f.slug}>
                  <span class="ic bad">
                    <Icon name="alert" />
                  </span>
                  <div class="txt">
                    <strong>
                      {plural(f.count, "transform failure")} in{" "}
                      <a href={to.lane(f.slug)} class="mono">
                        {f.slug}
                      </a>
                    </strong>
                    <span class="muted">Attachments that failed to unpack are not readable by agents.</span>
                  </div>
                  <a class="btn btn-sm" href={to.messages({ lane: f.slug })}>
                    View messages
                  </a>
                </li>
              ))}
              {paused.map((l) => (
                <li key={l.slug}>
                  <span class="ic warn">
                    <Icon name="pause" />
                  </span>
                  <div class="txt">
                    <strong>
                      <a href={to.lane(l.slug)} class="mono">
                        {l.slug}
                      </a>{" "}
                      is paused
                    </strong>
                    <span class="muted">New mail to this lane is rejected until it is resumed.</span>
                  </div>
                  <button class="btn btn-sm" type="button" onClick={() => setLaneStatus(l.slug, "active")}>
                    Resume
                  </button>
                </li>
              ))}
              <li>
                <span class="ic idle">
                  <Icon name="ban" />
                </span>
                <div class="txt">
                  <strong>{plural(rejections, "rejection")} in the last 48 hours</strong>
                  <span class="muted">
                    {plural(data.rejections_48h.probe, "probe")} to unknown addresses, {data.rejections_48h.lane} refused by a lane’s rules.
                  </span>
                </div>
                <a class="btn btn-sm" href={to.rejections()}>
                  Open log
                </a>
              </li>
            </ul>
          </section>

          <section class="panel" aria-labelledby="lanes-h">
            <div class="panel-head">
              <h2 id="lanes-h">Lanes</h2>
            </div>
            <div class="table-wrap">
              <table class="table stack-sm">
                <thead>
                  <tr>
                    <th>Lane</th>
                    <th>Status</th>
                    <th class="num">Messages</th>
                    <th class="num">Unprocessed</th>
                    <th class="num">Agents</th>
                    <th>Last received</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lanes.map((l) => (
                    <tr key={l.slug} class="clickable" onClick={rowLink(to.lane(l.slug))}>
                      <td data-l="Lane">
                        <a href={to.lane(l.slug)} class="mono">
                          {l.slug}
                        </a>
                        {l.description && <div class="muted small">{l.description}</div>}
                      </td>
                      <td data-l="Status">
                        <LaneStatusPill status={l.status} />
                      </td>
                      <td data-l="Messages" class="num">
                        {l.message_count}
                      </td>
                      <td data-l="Unprocessed" class="num">
                        {l.unprocessed_count ? <strong>{l.unprocessed_count}</strong> : <span class="muted">0</span>}
                      </td>
                      <td data-l="Agents" class="num">
                        {l.agent_count}
                      </td>
                      <td data-l="Last received" class="nowrap" title={l.last_received_at ? formatFull(l.last_received_at) : undefined}>
                        {timeAgo(l.last_received_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
