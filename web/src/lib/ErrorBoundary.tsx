import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { label: string; children: ReactNode }
interface State { error: Error | null }

/**
 * Swarm rule: one dead panel must never blank the Cesium canvas.
 * Every panel in App.tsx is wrapped in this.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.warn(`[TokyoPulse] panel "${this.props.label}" crashed:`, error.message, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="panel panel-error" role="status">
          <strong>{this.props.label}</strong>
          <span>panel unavailable</span>
        </div>
      );
    }
    return this.props.children;
  }
}
