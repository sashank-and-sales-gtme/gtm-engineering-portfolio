import { Component, type ReactNode } from "react";

/* Catches a crash inside one view so the sidebar and navigation stay put. The view can be reloaded in place, and
   the error's details copied for whoever looks into it. Keyed on the tab, so moving to another view resets it. */

type State = { err: Error | null; n: number };

export default class ViewBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { err: null, n: 0 };

  static getDerivedStateFromError(err: Error) {
    return { err };
  }

  componentDidCatch(err: Error, info: { componentStack?: string | null }) {
    console.error("View crashed:", err, info.componentStack);
  }

  render() {
    const { err, n } = this.state;
    if (!err) return <div key={n} style={{ display: "contents" }}>{this.props.children}</div>;
    const details = `${err.name}: ${err.message}\n${(err.stack || "").split("\n").slice(1, 6).join("\n")}\n${location.href}\n${new Date().toISOString()}`;
    return (
      <div className="card pad view-err" role="alert">
        <h2>This view hit a problem</h2>
        <p className="note">The rest of the app still works. Reload the view to try again; if it keeps happening, copy the details for whoever looks after the roster.</p>
        <div className="row">
          <button className="btn" onClick={() => this.setState({ err: null, n: n + 1 })}>Reload view</button>
          <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(details)}>Copy details</button>
        </div>
      </div>
    );
  }
}
