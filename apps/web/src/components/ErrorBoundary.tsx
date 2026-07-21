/**
 * Last-resort rendering guard (P9 audit): React unmounts the WHOLE tree when
 * a render throws and no boundary catches it — on a dashboard that's a blank
 * page with no way back. This boundary swaps the crash for a message and a
 * reload button (a full reload IS the right recovery: the SPA state that
 * crashed the render is exactly what must be thrown away).
 */
import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Injectable for tests; defaults to a real page reload. */
  reload?: () => void;
}

interface ErrorBoundaryState {
  crashed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { crashed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { crashed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error('unrecoverable render error', error);
  }

  override render(): ReactNode {
    if (!this.state.crashed) {
      return this.props.children;
    }
    const reload = this.props.reload ?? ((): void => window.location.reload());
    return (
      <main className="page">
        <h1>Something went wrong</h1>
        <p className="notice">The dashboard hit an unexpected error while rendering.</p>
        <button className="primary" onClick={reload}>
          Reload
        </button>
      </main>
    );
  }
}
