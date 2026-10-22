import { useSyncExternalStore } from 'react';
import { useRuntime, useSettings } from '../connections/context';
import { Button } from '../components/ui/button';
import { SwitchField } from '../components/ui/switch';

export function NotificationSettings() {
  const { notifications } = useRuntime();
  const settings = useSettings();
  const state = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);
  const enabled = Boolean(state.push?.subscribed) && state.permission === 'granted';
  const problem =
    state.push && !state.push.enabled
      ? 'Off in mekaweb’s config: set push.subject.'
      : state.availability === 'insecure'
        ? 'Push notifications need HTTPS.'
        : state.availability === 'install'
          ? 'On iPhone and iPad, open mekaweb from the Home Screen first.'
          : state.availability === 'unsupported'
            ? 'Push notifications are unavailable in this browser.'
            : state.permission === 'denied'
              ? 'Blocked: allow them in the browser’s site settings.'
              : state.error;
  return (
    <section className="panel">
      <h2>Notifications</h2>
      <div className="notification-settings-row">
        <SwitchField
          label="Push notifications on this device"
          id="push-notifications"
          aria-describedby="notification-description"
          checked={enabled}
          disabled={
            state.busy ||
            state.availability !== 'available' ||
            state.permission === 'denied' ||
            !state.push?.enabled
          }
          onCheckedChange={(checked) => {
            if (checked) void notifications.enable();
            else void notifications.disable();
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          aria-label="Send a test push notification"
          disabled={!enabled || state.busy}
          onClick={() => void notifications.test()}
        >
          Test
        </Button>
      </div>
      <p id="notification-description" className="muted notification-description" role="status">
        {problem ?? 'When a turn ends or waits for approval, even with mekaweb closed.'}
      </p>
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
