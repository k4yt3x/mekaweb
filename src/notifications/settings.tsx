import { useSyncExternalStore } from 'react';
import { useRuntime, useSettings } from '../connections/context';
import { Button } from '../components/ui/button';
import { SwitchField } from '../components/ui/switch';

export function NotificationSettings() {
  const { notifications } = useRuntime();
  const settings = useSettings();
  const state = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);
  const enabled = settings.turnNotifications && state.permission === 'granted';
  const problem =
    state.availability === 'insecure'
      ? 'Browser notifications require HTTPS or localhost.'
      : state.availability === 'install'
        ? 'Add mekaweb to your Home Screen and open it there to enable browser notifications.'
        : state.availability === 'unsupported'
          ? 'Browser notifications are unavailable in this browser.'
          : state.permission === 'denied'
            ? 'Notifications are blocked. Allow them in your browser’s site settings.'
            : state.error;
  return (
    <section className="panel">
      <h2>Notifications</h2>
      <div className="notification-settings-row">
        <SwitchField
          label="Browser notifications"
          id="browser-notifications"
          aria-describedby={problem ? 'notification-description' : undefined}
          checked={enabled}
          disabled={
            state.busy || state.availability !== 'available' || state.permission === 'denied'
          }
          onCheckedChange={(checked) => {
            if (checked) void notifications.enable();
            else notifications.disable();
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          aria-label="Test browser notifications"
          disabled={!enabled || state.busy}
          onClick={() => void notifications.test()}
        >
          Test
        </Button>
      </div>
      {problem && (
        <p id="notification-description" className="muted notification-description" role="status">
          {problem}
        </p>
      )}
      <div className="notification-settings-row">
        <SwitchField
          label="In-app notifications"
          id="in-app-notifications"
          checked={settings.inAppNotifications}
          onCheckedChange={(checked) => notifications.setInApp(checked)}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!settings.inAppNotifications}
          aria-label="Test in-app notifications"
          onClick={() => notifications.testInApp()}
        >
          Test
        </Button>
      </div>
      {state.appError && (
        <p className="muted notification-description" role="status">
          {state.appError}
        </p>
      )}
      <div className="notification-settings-row">
        <SwitchField
          label="Completion sound"
          id="completion-sound"
          checked={settings.completionSound}
          onCheckedChange={(checked) => notifications.setSound(checked)}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!settings.completionSound}
          aria-label="Test completion sound"
          onClick={() => void notifications.testSound()}
        >
          Test
        </Button>
      </div>
      {state.soundError && (
        <p className="muted notification-description" role="status">
          {state.soundError}
        </p>
      )}
    </section>
  );
}
