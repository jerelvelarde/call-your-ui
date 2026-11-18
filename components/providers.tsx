"use client";

import { Component, useEffect } from "react";
import type { ReactNode } from "react";
import { COPILOTKIT_RUNTIME_URL } from "@/lib/config";
import { CopilotKitProvider, standardUI } from "@/lib/cpk";
import type { CopilotKitProviderProps } from "@/lib/cpk";

/**
 * Generative UI with the standard catalog, in the page's violet. Module-level so its identity never
 * changes: a new object would make the provider rebuild the generative UI runtime.
 */
const GENUI: NonNullable<CopilotKitProviderProps["generativeUI"]> = {
  ui: standardUI,
  theme: {
    "--a2ui-color-accent": "#6430AB",
    "--a2ui-color-on-accent": "#ffffff",
    "--a2ui-font-family":
      'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    dark: {
      "--a2ui-color-accent": "#9b7bd8",
      "--a2ui-color-on-accent": "#140d20",
    },
  },
};

/** Generated surfaces switch to their dark values under a `.dark` ancestor: follow the system setting. */
function useSystemDarkClass() {
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
}

/** Whatever breaks, the page says so in plain words instead of going blank. */
class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  componentDidCatch(error: unknown) {
    console.error("[app] the page failed to render", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page-error" role="alert">
        <h1>The page hit an error.</h1>
        <p>{this.state.error.message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

export function Providers({ children }: { children: ReactNode }) {
  useSystemDarkClass();
  return (
    <PageBoundary>
      <CopilotKitProvider
        runtimeUrl={COPILOTKIT_RUNTIME_URL}
        generativeUI={GENUI}
        enableInspector={false}
        // app/layout.tsx imports @copilotkit/core/styles.css, so the provider adds no <style> tag.
        injectStyles={false}
      >
        {children}
      </CopilotKitProvider>
    </PageBoundary>
  );
}
