import type { ComponentChildren } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AgentView, OverviewView, SessionView } from "../worker/admin/types.ts";
import { sessionExpired } from "./api.ts";
import { useResource } from "./data.ts";
import { Modal } from "./dialogs.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { OverviewContext } from "./overview-context.ts";
import { navigate, to, type Route } from "./router.ts";
import { useStore } from "./store.ts";
import { applyTheme, loadTheme, type Theme } from "./theme.ts";
import { requestNewAgent } from "./screens/new-agent.ts";

const SCREENS: { id: string; label: string; icon: IconName; href: string }[] = [
  { id: "overview", label: "Overview", icon: "home", href: to.overview() },
  { id: "messages", label: "Messages", icon: "mail", href: to.messages() },
  { id: "agents", label: "Agents", icon: "agent", href: to.agents() },
  { id: "rejections", label: "Rejections", icon: "ban", href: to.rejections() },
];

function currentScreen(route: Route): string {
  switch (route.name) {
    case "message":
    case "messages":
      return "messages";
    case "agents":
    case "rejections":
      return route.name;
    default:
      return "overview";
  }
}

function SessionBanner() {
  const expired = useStore(sessionExpired);
  if (!expired) return null;
  return (
    <div class="banner bad" role="alert">
      <Icon name="lock" />
      <p>
        <strong>Session expired.</strong> Cloudflare Access needs you to sign in again before anything else can be loaded or saved.
      </p>
      <button class="btn btn-sm" type="button" onClick={() => location.reload()}>
        Sign in again
      </button>
    </div>
  );
}

function ThemePicker() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  return (
    <div class="seg theme-seg" role="group" aria-label="Theme">
      {(["system", "light", "dark"] as const).map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={theme === t}
          onClick={() => {
            setTheme(t);
            applyTheme(t);
          }}
        >
          {t[0]!.toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
}

function Nav({ route, open }: { route: Route; open: boolean }) {
  const overview = useContext(OverviewContext).data;
  const screen = currentScreen(route);
  const unprocessed = overview?.lanes.reduce((n, l) => n + l.unprocessed_count, 0) ?? 0;
  const lane = route.name === "lane" || route.name === "edit-lane" ? route.slug : null;
  return (
    <nav class={`sidenav${open ? " open" : ""}`} id="nav" aria-label="Main">
      {SCREENS.map((s) => (
        <a key={s.id} class="nav-link" href={s.href} aria-current={screen === s.id && !lane ? "page" : undefined}>
          <Icon name={s.icon} />
          {s.label}
          {s.id === "messages" && overview && (
            <span class="count" aria-label={`${unprocessed} unprocessed`}>
              {unprocessed}
            </span>
          )}
        </a>
      ))}
      <div class="nav-group">Lanes</div>
      {overview?.lanes.map((l) => (
        <a key={l.slug} class="nav-link lane-link" href={to.lane(l.slug)} aria-current={lane === l.slug ? "page" : undefined}>
          <Icon name="lane" />
          <span class="mono">{l.slug}</span>
          {l.status === "paused" ? <span class="count">paused</span> : l.unprocessed_count > 0 && <span class="count">{l.unprocessed_count}</span>}
        </a>
      ))}
      <div class="nav-foot">
        <ThemePicker />
        <span>
          Press <kbd>?</kbd> for shortcuts
        </span>
      </div>
    </nav>
  );
}

/* ---------- Command palette ---------- */

interface PaletteItem {
  label: string;
  kind: string;
  mono?: boolean;
  run: () => void;
}

function Palette({ onClose }: { onClose: () => void }) {
  const overview = useContext(OverviewContext).data;
  const agents = useResource<AgentView[]>("/api/agents").data;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  // Messages are left out on purpose: they would put email text in the chrome.
  const items = useMemo<PaletteItem[]>(
    () => [
      ...SCREENS.map((s) => ({ label: s.label, kind: "Screen", run: () => navigate(s.href) })),
      { label: "New lane", kind: "Action", run: () => navigate(to.newLane()) },
      { label: "New agent", kind: "Action", run: requestNewAgent },
      ...(overview?.lanes ?? []).map((l) => ({ label: l.slug, kind: "Lane", mono: true, run: () => navigate(to.lane(l.slug)) })),
      ...(agents ?? []).map((a) => ({ label: a.name, kind: "Agent", mono: true, run: () => navigate(to.agents()) })),
    ],
    [overview, agents],
  );
  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => !q || i.label.toLowerCase().includes(q) || i.kind.toLowerCase().includes(q)).slice(0, 12);
  const index = Math.min(selected, Math.max(0, shown.length - 1));

  const go = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <Modal class="pal" label="Command palette" onClose={onClose} dismissOnBackdrop>
      <label class="sr" for="pal-q">
        Go to
      </label>
      <input
        id="pal-q"
        placeholder="Go to a screen, lane or agent"
        autocomplete="off"
        role="combobox"
        aria-controls="pal-list"
        aria-expanded="true"
        aria-activedescendant={shown.length ? `po-${index}` : undefined}
        value={query}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setSelected(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelected(Math.min(index + 1, shown.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelected(Math.max(index - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            go(shown[index]);
          }
        }}
      />
      <ul id="pal-list" role="listbox">
        {shown.length ? (
          shown.map((item, n) => (
            <li key={`${item.kind}-${item.label}`} role="option" id={`po-${n}`} aria-selected={n === index} onClick={() => go(item)}>
              {item.mono ? <span class="mono">{item.label}</span> : item.label}
              <span class="k">{item.kind}</span>
            </li>
          ))
        ) : (
          <li class="pal-empty">No matches</li>
        )}
      </ul>
      <div class="foot">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> open
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
        <span>Messages are not listed: their subjects stay out of the palette.</span>
      </div>
    </Modal>
  );
}

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal labelledBy="shortcuts-title" onClose={onClose}>
      <form method="dialog">
        <div class="dlg-head">
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        </div>
        <div class="dlg-body">
          <dl class="dl">
            <dt>
              <kbd>⌘</kbd> <kbd>K</kbd> or <kbd>Ctrl</kbd> <kbd>K</kbd>
            </dt>
            <dd>Command palette</dd>
            <dt>
              <kbd>/</kbd>
            </dt>
            <dd>Focus the search on this screen</dd>
            <dt>
              <kbd>g</kbd> then <kbd>o</kbd>
            </dt>
            <dd>Overview</dd>
            <dt>
              <kbd>g</kbd> then <kbd>m</kbd>
            </dt>
            <dd>Messages</dd>
            <dt>
              <kbd>g</kbd> then <kbd>a</kbd>
            </dt>
            <dd>Agents</dd>
            <dt>
              <kbd>g</kbd> then <kbd>r</kbd>
            </dt>
            <dd>Rejections</dd>
            <dt>
              <kbd>n</kbd>
            </dt>
            <dd>New lane (Overview) or new agent (Agents)</dd>
            <dt>
              <kbd>?</kbd>
            </dt>
            <dd>This list</dd>
          </dl>
          <p class="muted">No single-key shortcut deletes, rotates or revokes anything.</p>
        </div>
        <div class="dlg-foot">
          <button class="btn btn-primary">Close</button>
        </div>
      </form>
    </Modal>
  );
}

function useShortcuts(route: Route, actions: { palette: () => void; help: () => void }) {
  const latest = useRef({ route, actions });
  latest.current = { route, actions };
  useEffect(() => {
    let goPending = 0;
    const onKey = (e: KeyboardEvent) => {
      const { route, actions } = latest.current;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        actions.palette();
        return;
      }
      const target = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable) return;
      if (document.querySelector("dialog[open]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        const search = document.querySelector<HTMLInputElement>("[data-search]");
        if (search) {
          e.preventDefault();
          search.focus();
        }
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        actions.help();
        return;
      }
      if (goPending && Date.now() - goPending < 1200) {
        goPending = 0;
        const dest = { o: to.overview(), m: to.messages(), a: to.agents(), r: to.rejections() }[e.key];
        if (dest) {
          e.preventDefault();
          navigate(dest);
        }
        return;
      }
      if (e.key === "g") goPending = Date.now();
      else if (e.key === "n") {
        if (route.name === "overview") navigate(to.newLane());
        else if (route.name === "agents") requestNewAgent();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
}

export function Shell({ route, children }: { route: Route; children: ComponentChildren }) {
  const overview = useResource<OverviewView>("/api/overview");
  const session = useResource<SessionView>("/api/session").data;
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const main = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  useShortcuts(route, { palette: () => setPalette((open) => !open), help: () => setHelp(true) });

  // Navigating closes the menu and moves focus to the new screen's content.
  const routeKey = JSON.stringify(route);
  const first = useRef(true);
  useEffect(() => {
    setMenu(false);
    if (first.current) first.current = false;
    else {
      main.current?.focus({ preventScroll: true });
      scrollTo(0, 0);
    }
  }, [routeKey]);

  // Listening from the start (rather than from an effect that runs after the menu opens) means a quick
  // Escape or tap outside is never missed.
  const menuOpen = useRef(menu);
  menuOpen.current = menu;
  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (menuOpen.current && !(e.target as HTMLElement).closest("#nav,#menu-btn")) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (menuOpen.current && e.key === "Escape") {
        setMenu(false);
        menuButton.current?.focus();
      }
    };
    addEventListener("pointerdown", onPointer);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("pointerdown", onPointer);
      removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <OverviewContext.Provider value={overview}>
      <div id="app">
        <header class="topbar">
          <button
            ref={menuButton}
            class="btn btn-ghost btn-icon menu-btn"
            type="button"
            id="menu-btn"
            aria-expanded={menu}
            aria-controls="nav"
            aria-label="Menu"
            onClick={() => setMenu(!menu)}
          >
            <span class="when-closed">
              <Icon name="menu" />
            </span>
            <span class="when-open">
              <Icon name="x" />
            </span>
          </button>
          <a class="brand" href={to.overview()}>
            <span class="brand-mark" aria-hidden="true">
              <Icon name="mail" />
            </span>
            Agent Inbox <small>admin</small>
          </a>
          <span class="spacer" />
          <button class="palette-btn" type="button" aria-label="Open command palette" onClick={() => setPalette(true)}>
            <Icon name="search" />
            <span>Go to…</span>
            <kbd>⌘K</kbd>
          </button>
          <span class="who" title="Signed in through Cloudflare Access">
            {session?.email ?? ""}
          </span>
        </header>
        <Nav route={route} open={menu} />
        <main class="main" id="main" tabIndex={-1} ref={main}>
          <SessionBanner />
          {children}
        </main>
      </div>
      {palette && <Palette onClose={() => setPalette(false)} />}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
    </OverviewContext.Provider>
  );
}
