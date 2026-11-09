import { PanelLeftOpen, Plus, Search, Settings, UserRound } from 'lucide-react';
import { useConnection } from '../connections/context';
import { Button } from '../components/ui/button';
import { MekaLogo } from '../components/layout';
import { useOpenSettings } from '../components/settings-control';
import { shortcutAttribute, shortcutHint } from '../components/shortcut-keys';
import { SIDEBAR_PAGES, type SidebarPage } from './sidebar-pages';

/**
 * The sidebar collapsed, on a wide screen: a column of icons, headed by Meka's logo, which opens it
 * again and shows so when pointed at; then its pages, the one shown marked; then to start or search
 * sessions, which opens it to search; and at its foot to reach the account and Settings.
 */
export function SidebarRail({
  page,
  canCreate,
  onExpand,
  onCreate,
  onSearch,
}: {
  page: SidebarPage | undefined;
  canCreate: boolean;
  onExpand: () => void;
  onCreate: () => void;
  onSearch: () => void;
}) {
  const openSettings = useOpenSettings();
  const { account, info } = useConnection();
  return (
    <div className="sidebar-rail">
      <Button
        variant="ghost"
        size="icon"
        className="sidebar-rail-logo"
        aria-label="Expand sidebar"
        title="Expand sidebar"
        aria-expanded={false}
        aria-controls="session-list"
        onClick={onExpand}
      >
        <MekaLogo />
        <PanelLeftOpen size={18} aria-hidden="true" />
      </Button>
      {SIDEBAR_PAGES.filter((each) => !each.scope || info?.scopes.includes(each.scope)).map(
        (each) => (
          <a
            key={each.id}
            href={`#${each.path}`}
            className="button button-ghost button-icon"
            aria-label={each.name}
            title={each.name}
            aria-current={each.id === page ? 'page' : undefined}
          >
            <each.icon size={18} aria-hidden="true" />
          </a>
        ),
      )}
      <span className="sidebar-rail-divider" aria-hidden="true" />
      <Button
        variant="ghost"
        size="icon"
        aria-label="New session"
        title={`New session (${shortcutHint('newSession')})`}
        aria-keyshortcuts={shortcutAttribute('newSession')}
        disabled={!canCreate}
        onClick={onCreate}
      >
        <Plus size={18} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Search sessions"
        title={`Search sessions (${shortcutHint('searchSessions')})`}
        aria-keyshortcuts={shortcutAttribute('searchSessions')}
        onClick={onSearch}
      >
        <Search size={17} />
      </Button>
      <span className="sidebar-rail-gap" />
      {account && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Account settings for ${account.username}`}
          title={account.username}
          onClick={() => openSettings('account')}
        >
          <UserRound size={18} />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Settings"
        title="Settings"
        onClick={() => openSettings()}
      >
        <Settings size={18} />
      </Button>
    </div>
  );
}
