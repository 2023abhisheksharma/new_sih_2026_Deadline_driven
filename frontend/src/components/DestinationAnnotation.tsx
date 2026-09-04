import type { FC } from "react";
import type { PortRecord } from "../types/port";

interface DestinationAnnotationProps {
  port: PortRecord;
  screenPosition: { x: number; y: number } | null;
}

export const DestinationAnnotation: FC<DestinationAnnotationProps> = ({
  port,
  screenPosition,
}) => {
  if (!screenPosition) return null;

  const latStr = `${Math.abs(port.latitude).toFixed(4)}° ${port.latitude < 0 ? "S" : "N"}`;
  const lonStr = `${Math.abs(port.longitude).toFixed(4)}° ${port.longitude < 0 ? "W" : "E"}`;

  const annotationWidth = 185;
  const offset = 14;

  const showOnLeft = screenPosition.x + offset + annotationWidth > window.innerWidth - 12;
  const left = showOnLeft
    ? screenPosition.x - offset - annotationWidth
    : screenPosition.x + offset;

  const top = screenPosition.y - 18;

  return (
    <div
      className="absolute z-20 pointer-events-none select-none font-sans"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${annotationWidth}px`,
      }}
      role="region"
      aria-label="Mission Destination Map Annotation"
    >
      <div className="bg-polar-950/90 px-2.5 py-1.5 rounded border border-polar-800 text-slate-200 shadow-sm">
        <div className="text-[10px] uppercase tracking-wider text-slate-400 font-medium leading-tight font-sans flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
          Mission Destination
        </div>
        <div className="text-xs font-medium text-slate-100 mt-0.5 leading-tight truncate font-sans">
          {port.portName}
        </div>
        <div className="text-[9.5px] text-slate-400 mt-0.5 leading-tight font-sans">
          {latStr}&nbsp;&nbsp;{lonStr}
        </div>
      </div>
    </div>
  );
};
