import type * as React from "react";
import type { CellMessage, CellRuntimeState } from "./marimo-frontend.ts";

interface CellOutputProps {
  state: CellRuntimeState;
  message: CellMessage;
  renderHTML: (props: { html: string }) => React.ReactNode;
}

/**
 * Component that renders cell output based on the full runtime state.
 * Handles different output types including HTML, errors, console outputs, and status indicators.
 */
export function CellOutput({ state, renderHTML }: CellOutputProps) {
  const { consoleOutputs, output } = state;
  return (
    <div className="marimo-cell-output">
      {consoleOutputs.length > 0 && (
        <div className="console-outputs">
          {consoleOutputs.map((consoleOutput: any, idx: number) => (
            <div
              key={idx}
              className={`console-output console-${consoleOutput.channel}`}
            >
              {consoleOutput.mimetype === "text/plain" ? (
                <pre>{consoleOutput.data}</pre>
              ) : (
                <div>{renderHTML({ html: String(consoleOutput.data) })}</div>
              )}
            </div>
          ))}
        </div>
      )}
      {output && (
        <div className="cell-main-output">
          {output.mimetype === "text/html" ? (
            <div className="p-4">
              {renderHTML({ html: String(output.data) })}
            </div>
          ) : output.mimetype === "application/vnd.marimo+error" ? (
            <div className="error-output">
              {Array.isArray(output.data) &&
                output.data.map((error: any, idx: number) => (
                  <div key={idx} className="error-item">
                    <div className="error-type">{error.type}</div>
                    {error.msg && (
                      <div className="error-message">{error.msg}</div>
                    )}
                    {error.traceback && (
                      <pre className="error-traceback">{error.traceback}</pre>
                    )}
                  </div>
                ))}
            </div>
          ) : output.mimetype === "text/plain" ? (
            <pre>{String(output.data)}</pre>
          ) : output.mimetype === "image/png" ||
            output.mimetype === "image/jpeg" ? (
            <img
              src={`data:${output.mimetype};base64,${output.data}`}
              alt="Cell output"
            />
          ) : (
            <div className="unknown-output">
              <small>Unknown output type: {output.mimetype}</small>
              <pre>{JSON.stringify(output.data, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
