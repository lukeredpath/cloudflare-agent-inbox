import { DialogHost } from "./dialogs.tsx";
import { useRoute, type Route } from "./router.ts";
import { AgentsScreen } from "./screens/agents.tsx";
import { LaneFormScreen } from "./screens/lane-form.tsx";
import { LaneScreen } from "./screens/lane.tsx";
import { MessageScreen } from "./screens/message.tsx";
import { MessagesScreen } from "./screens/messages.tsx";
import { Overview } from "./screens/overview.tsx";
import { RejectionsScreen } from "./screens/rejections.tsx";
import { Shell } from "./shell.tsx";
import { Toasts } from "./toast.tsx";
import { NotFound } from "./ui.tsx";

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "overview":
      return <Overview />;
    case "messages":
      return <MessagesScreen lane={route.lane} status={route.status} />;
    case "message":
      return <MessageScreen id={route.id} />;
    case "agents":
      return <AgentsScreen />;
    case "rejections":
      return <RejectionsScreen />;
    case "new-lane":
      return <LaneFormScreen slug={null} />;
    case "lane":
      return <LaneScreen slug={route.slug} />;
    case "edit-lane":
      return <LaneFormScreen slug={route.slug} />;
    default:
      return <NotFound />;
  }
}

export function App() {
  const route = useRoute();
  return (
    <>
      <Shell route={route}>
        {/* Keyed by route so each screen starts with fresh state. */}
        <Screen key={JSON.stringify(route)} route={route} />
      </Shell>
      <Toasts />
      <DialogHost />
    </>
  );
}
