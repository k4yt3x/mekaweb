import { useState } from 'react';
import { ChevronDown, Circle, CircleDot, Clock, ListChecks } from 'lucide-react';
import type { Schema } from '../api/client';

const statuses = {
  in_progress: { Icon: CircleDot, label: 'In progress' },
  pending: { Icon: Circle, label: 'Pending' },
  deferred: { Icon: Clock, label: 'Deferred' },
};

/**
 * The agent's open checklist, above the message input: what it has committed to and not yet
 * finished. meka does not let a turn end while an item is pending or in progress, so this is also
 * why a turn keeps going after its answer.
 */
export function ChecklistStrip({ items }: { items: Schema['ChecklistItem'][] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const current =
    items.find((item) => item.status === 'in_progress') ??
    items.find((item) => item.status === 'pending');
  return (
    <section className="checklist-strip" aria-label="Checklist" data-open={open || undefined}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ListChecks size={14} aria-hidden="true" />
        <strong>Checklist</strong>
        <span className="checklist-count">{items.length} open</span>
        {!open && current && <span className="checklist-current">{current.text}</span>}
        <ChevronDown className="checklist-chevron" size={14} aria-hidden="true" />
      </button>
      {open && (
        <ul>
          {items.map((item) => {
            // A newer meka may have a status this client does not know; it is shown plainly.
            const { Icon, label } = statuses[item.status] ?? { Icon: Circle, label: item.status };
            return (
              <li key={item.id} data-status={item.status}>
                <Icon size={13} aria-label={label} role="img" />
                <span>
                  {item.text}
                  {item.reason && <span className="checklist-reason"> · {item.reason}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
