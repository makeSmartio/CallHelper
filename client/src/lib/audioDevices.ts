export const MIC_DEVICE_KEY = 'copilot_mic_device_id';

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

export function getStoredMicDeviceId(): string | null {
  try {
    const stored = localStorage.getItem(MIC_DEVICE_KEY);
    return stored && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

export function storeMicDeviceId(deviceId: string): void {
  try {
    localStorage.setItem(MIC_DEVICE_KEY, deviceId);
  } catch {
    // ignore quota / private-mode failures
  }
}

export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return [];
  }

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label:
        device.label.trim().length > 0
          ? device.label
          : `Microphone ${index + 1}`,
    }));
}
