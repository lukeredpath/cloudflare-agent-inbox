import { createContext } from "preact";
import type { OverviewView } from "../worker/admin/types.ts";
import type { Resource } from "./data.ts";

/** The overview is loaded once by the shell: the navigation needs its counts on every screen. */
export const OverviewContext = createContext<Resource<OverviewView>>({ data: undefined, error: undefined, loading: true });
