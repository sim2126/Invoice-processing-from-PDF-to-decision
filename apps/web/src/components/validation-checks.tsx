import { ChevronDown } from "lucide-react";
import type { Detail } from "@/lib/api";
import { cn } from "@/lib/utils";
import { StateIcon } from "./common";

type Check = NonNullable<Detail["decision"]>["checks"][number];
function CheckRow({ check }: { check: Check }) {
  return (
    <details
      className={cn("check-row", `check-${check.state}`)}
      open={check.state !== "passed"}
    >
      <summary>
        <StateIcon state={check.state} size={16} />
        <strong>{check.title}</strong>
        <span>
          {check.state === "passed"
            ? "Passed"
            : check.state === "blocked"
              ? "Blocked"
              : "Review"}
        </span>
        <ChevronDown size={13} />
      </summary>
      <p>{check.message}</p>
    </details>
  );
}
export function ValidationChecks({ checks }: { checks: Check[] }) {
  const primary = (c: Check) =>
    c.state !== "passed" ||
    ["vendor", "po", "evidence", "arithmetic", "duplicate", "budget"].includes(
      c.code,
    ) ||
    c.code.startsWith("quantity_");
  const visible = checks
    .filter(primary)
    .sort(
      (a, b) => Number(a.state === "passed") - Number(b.state === "passed"),
    );
  const supporting = checks.filter((c) => !primary(c));
  return (
    <div className="check-list">
      {visible.map((check, index) => (
        <CheckRow check={check} key={`${check.code}-${index}`} />
      ))}
      {!!supporting.length && (
        <details className="supporting-checks">
          <summary>
            {supporting.length} supporting checks passed
            <ChevronDown size={14} />
          </summary>
          {supporting.map((check, index) => (
            <CheckRow check={check} key={`${check.code}-${index}`} />
          ))}
        </details>
      )}
    </div>
  );
}
