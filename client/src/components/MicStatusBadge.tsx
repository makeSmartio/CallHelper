import React from 'react';
import { AudioInputDevice } from '../lib/audioDevices';

interface MicStatusBadgeProps {
  status: 'connected' | 'ready' | 'disconnected' | 'connecting';
  devices: AudioInputDevice[];
  selectedDeviceId: string;
  activeDeviceLabel: string | null;
  onDeviceChange: (deviceId: string) => void;
  onDropdownFocus?: () => void;
  disabled?: boolean;
}

const statusConfig = {
  connected: { dot: 'bg-green-400', text: 'text-green-400', label: 'Connected' },
  ready: { dot: 'bg-green-400', text: 'text-green-400', label: 'Ready' },
  connecting: {
    dot: 'bg-yellow-400 animate-pulse',
    text: 'text-yellow-400',
    label: 'Connecting',
  },
  disconnected: { dot: 'bg-gray-500', text: 'text-gray-400', label: 'Offline' },
};

export const MicStatusBadge: React.FC<MicStatusBadgeProps> = ({
  status,
  devices,
  selectedDeviceId,
  activeDeviceLabel,
  onDeviceChange,
  onDropdownFocus,
  disabled = false,
}) => {
  const cfg = statusConfig[status];
  const selectValue =
    devices.some((device) => device.deviceId === selectedDeviceId)
      ? selectedDeviceId
      : devices[0]?.deviceId ?? '';

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-gray-800 border border-gray-700 max-w-[min(100%,320px)]">
      <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${cfg.dot}`} />
      <span className="text-xs text-gray-400 shrink-0">Mic</span>
      <select
        value={selectValue}
        onChange={(event) => onDeviceChange(event.target.value)}
        onFocus={onDropdownFocus}
        disabled={disabled || devices.length === 0}
        title={
          activeDeviceLabel
            ? `Active microphone: ${activeDeviceLabel}`
            : 'Select microphone'
        }
        className="min-w-0 max-w-[180px] flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-200 truncate focus:outline-none focus:border-emerald-600 disabled:opacity-50"
      >
        {devices.length === 0 ? (
          <option value="">No microphones found</option>
        ) : (
          devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))
        )}
      </select>
      <span className={`text-xs font-medium shrink-0 ${cfg.text}`}>{cfg.label}</span>
    </div>
  );
};
