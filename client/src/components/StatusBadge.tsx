import React from 'react';

interface StatusBadgeProps {
  label: string;
  status: 'connected' | 'ready' | 'disconnected' | 'connecting' | 'error' | 'mock' | 'paused' | 'off';
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
}

const statusConfig = {
  connected:    { dot: 'bg-green-400',  text: 'text-green-400',  label: 'Connected' },
  ready:        { dot: 'bg-green-400',  text: 'text-green-400',  label: 'Ready' },
  connecting:   { dot: 'bg-yellow-400 animate-pulse', text: 'text-yellow-400', label: 'Connecting' },
  disconnected: { dot: 'bg-gray-500',   text: 'text-gray-400',   label: 'Offline' },
  error:        { dot: 'bg-red-500',    text: 'text-red-400',    label: 'Error' },
  mock:         { dot: 'bg-purple-400', text: 'text-purple-300', label: 'Mock' },
  paused:       { dot: 'bg-amber-400',  text: 'text-amber-400',  label: 'Paused' },
  off:          { dot: 'bg-gray-500',   text: 'text-gray-400',   label: 'Off' },
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  label,
  status,
  onClick,
  title,
  disabled = false,
}) => {
  const cfg = statusConfig[status];
  const className = `flex items-center gap-1.5 px-2 py-1 rounded bg-gray-800 border border-gray-700 ${
    onClick && !disabled
      ? 'cursor-pointer hover:border-gray-500 transition-colors'
      : disabled
      ? 'opacity-60'
      : ''
  }`;
  const content = (
    <>
      <span className={`inline-block w-2 h-2 rounded-full ${cfg.dot}`} />
      <span className="text-xs text-gray-400">{label}</span>
      <span className={`text-xs font-medium ${cfg.text}`}>{cfg.label}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={className}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={className} title={title}>
      {content}
    </div>
  );
};
