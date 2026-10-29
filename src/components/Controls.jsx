import { Icon } from './Icons';

// A labelled group of toggle buttons. variant: "seg" (joined) or "chips" (wrapping pills)
export function Choice({ label, value, onChange, options, variant = 'chips' }) {
  return (
    <div className="opt">
      <span className="opt-label">{label}</span>
      <div className={variant} role="group" aria-label={label}>
        {options.map(o => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
          >
            {o.icon && <Icon name={o.icon} size={16} />}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Stat({ icon, label, value, note, tone }) {
  return (
    <div className="stat" data-tone={tone}>
      <span className="stat-icon"><Icon name={icon} size={18} /></span>
      <p className="stat-value">{value}</p>
      <p className="stat-label">{label}</p>
      {note && <p className="stat-note">{note}</p>}
    </div>
  );
}