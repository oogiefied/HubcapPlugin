import { callable, definePlugin, IconsModule, Millennium, playSectionClasses } from '@steambrew/client';

type BackendResult = {
	success: boolean;
	error?: string;
	exists?: boolean;
	removed?: boolean;
};

type LocationLike = {
	pathname: string;
	search?: string;
	hash?: string;
};

type Popup = {
	window?: Window;
};

type PopupManager = {
	GetExistingPopup(name: string): Popup | undefined;
	AddPopupCreatedCallback(callback: (popup: Popup) => void): { Unregister: () => void };
	AddPopupDestroyedCallback?(callback: (popup: Popup) => void): { Unregister: () => void };
};

type MainWindowBrowserManager = {
	m_lastLocation?: LocationLike;
};

const LIBRARY_BUTTON_ID = 'hubcap-library-remove-lua-button';
const LIBRARY_STATUS_ID = 'hubcap-library-remove-lua-status';
const LOCATION_POLL_INTERVAL = 250;
const ROUTE_RESYNC_INTERVAL = 2000;
const DESKTOP_WINDOW_NAME = 'SP Desktop_uid0';

const checkLua = callable<[{ app_id: string }], string>('check_lua_for_app');
const deleteLua = callable<[{ app_id: string }], string>('delete_lua_for_app');

const popupCleanups = new WeakMap<Popup, VoidFunction>();
let popupCreatedUnregister: VoidFunction | null = null;
let popupDestroyedUnregister: VoidFunction | null = null;

function getGlobal<T>(name: string): T | undefined {
	return Reflect.get(globalThis, name) as T | undefined;
}

function getPopupManager(): PopupManager | undefined {
	return getGlobal<PopupManager>('g_PopupManager');
}

function getMainWindowBrowserManager(): MainWindowBrowserManager | undefined {
	return getGlobal<MainWindowBrowserManager>('MainWindowBrowserManager');
}

function getLibraryAppId(location?: LocationLike): string | null {
	const match = /^\/(?:routes\/)?library\/app\/(\d+)(?:\/|$)/.exec(location?.pathname || '');
	return match?.[1] ?? null;
}

function parseBackendResult(raw: string): BackendResult {
	try {
		return JSON.parse(raw) as BackendResult;
	} catch {
		return { success: false, error: raw || 'Unexpected backend response.' };
	}
}

async function hasLua(appId: string): Promise<boolean> {
	const result = parseBackendResult(await checkLua({ app_id: appId }));
	return result.success === true && result.exists === true;
}

function removeEntrypoint(document: Document): void {
	document.querySelectorAll(`#${LIBRARY_BUTTON_ID}`).forEach((button) => button.remove());
}

function removeHubcapLibraryElements(document: Document): void {
	document.querySelectorAll(`#${LIBRARY_BUTTON_ID}, #${LIBRARY_STATUS_ID}`).forEach((element) => element.remove());
}

function hasCurrentHubcapElement(document: Document, appId: string): boolean {
	const selector = `#${LIBRARY_BUTTON_ID}[data-app-id="${appId}"], #${LIBRARY_STATUS_ID}[data-app-id="${appId}"]`;
	return document.querySelector(selector) !== null;
}

function getLibraryButtonAnchor(parent: HTMLElement): HTMLElement | null {
	return Array.from(parent.children).find((child) => child.id !== LIBRARY_BUTTON_ID && child.id !== LIBRARY_STATUS_ID) as HTMLElement | null;
}

function createRemoveLuaButton(window: Window, appId: string): HTMLButtonElement {
	const button = window.document.createElement('button');
	button.id = LIBRARY_BUTTON_ID;
	button.type = 'button';
	button.dataset.appId = appId;
	button.textContent = 'Remove Lua';
	button.title = `Remove Lua for app ${appId}`;
	button.style.alignItems = 'center';
	button.style.background = 'linear-gradient(180deg, #d94b3f 0%, #8f241d 100%)';
	button.style.border = '0';
	button.style.borderRadius = '2px';
	button.style.boxShadow = '0 1px 4px rgba(0, 0, 0, 0.35)';
	button.style.color = '#fff1ef';
	button.style.cursor = 'pointer';
	button.style.display = 'inline-flex';
	button.style.fontFamily = 'Arial, Helvetica, sans-serif';
	button.style.fontSize = '14px';
	button.style.height = '32px';
	button.style.justifyContent = 'center';
	button.style.lineHeight = '32px';
	button.style.marginRight = '8px';
	button.style.minWidth = '104px';
	button.style.padding = '0 14px';
	button.style.whiteSpace = 'nowrap';

	button.addEventListener('click', async (event) => {
		event.preventDefault();
		event.stopPropagation();

		button.disabled = true;
		button.textContent = 'Removing...';

		const result = parseBackendResult(await deleteLua({ app_id: appId }));
		if (result.success) {
			void showRemovedStatus(window, appId);
			return;
		}

		button.disabled = false;
		button.textContent = 'Remove failed';
		button.title = result.error || 'Remove failed.';
		window.setTimeout(() => {
			button.textContent = 'Remove Lua';
		}, 1600);
	});

	return button;
}

function createRemovedStatus(window: Window, appId: string): HTMLSpanElement {
	const status = window.document.createElement('span');
	status.id = LIBRARY_STATUS_ID;
	status.dataset.appId = appId;
	status.textContent = 'Removed!';
	status.title = `Lua removed for app ${appId}`;
	status.style.alignItems = 'center';
	status.style.color = '#8bc53f';
	status.style.display = 'inline-flex';
	status.style.fontFamily = 'Arial, Helvetica, sans-serif';
	status.style.fontSize = '14px';
	status.style.fontWeight = '700';
	status.style.height = '32px';
	status.style.justifyContent = 'center';
	status.style.lineHeight = '32px';
	status.style.marginRight = '8px';
	status.style.minWidth = '104px';
	status.style.padding = '0 14px';
	status.style.textShadow = '0 1px 2px rgba(0, 0, 0, 0.55)';
	status.style.whiteSpace = 'nowrap';
	return status;
}

async function showRemovedStatus(window: Window, appId: string): Promise<void> {
	const parents = await Millennium.findElement(window.document, `.${playSectionClasses.AppButtonsContainer}`, 5000);
	for (const parent of [...parents] as HTMLElement[]) {
		parent.querySelectorAll(`#${LIBRARY_BUTTON_ID}, #${LIBRARY_STATUS_ID}`).forEach((element) => element.remove());
		parent.insertBefore(createRemovedStatus(window, appId), getLibraryButtonAnchor(parent));
	}
}

async function syncLibraryRemoveButton(window: Window, appId: string): Promise<void> {
	if (!(await hasLua(appId))) {
		if (!hasCurrentHubcapElement(window.document, appId)) removeHubcapLibraryElements(window.document);
		else removeEntrypoint(window.document);
		return;
	}

	const parents = await Millennium.findElement(window.document, `.${playSectionClasses.AppButtonsContainer}`, 5000);
	for (const parent of [...parents] as HTMLElement[]) {
		const existing = parent.querySelector<HTMLButtonElement>(`#${LIBRARY_BUTTON_ID}`);
		if (existing?.dataset.appId === appId) continue;

		existing?.remove();
		parent.insertBefore(createRemoveLuaButton(window, appId), getLibraryButtonAnchor(parent));
	}
}

function startLibraryRouteMonitor(popup: Popup, getLocation: () => LocationLike | undefined): VoidFunction {
	let lastPathname = '';
	let lastSyncAt = 0;

	const intervalId = window.setInterval(() => {
		const location = getLocation();
		if (!location || !popup.window) return;

		if (!location.pathname.startsWith('/library') && !location.pathname.startsWith('/routes/library')) {
			removeHubcapLibraryElements(popup.window.document);
			return;
		}

		const appId = getLibraryAppId(location);
		if (appId) {
			const pathnameChanged = location.pathname !== lastPathname;
			const shouldRetryMissingElement =
				!hasCurrentHubcapElement(popup.window.document, appId) &&
				Date.now() - lastSyncAt > ROUTE_RESYNC_INTERVAL;

			if (!pathnameChanged && !shouldRetryMissingElement) return;
			if (pathnameChanged) removeHubcapLibraryElements(popup.window.document);

			lastPathname = location.pathname;
			lastSyncAt = Date.now();
			void syncLibraryRemoveButton(popup.window, appId);
		} else {
			removeHubcapLibraryElements(popup.window.document);
		}
	}, LOCATION_POLL_INTERVAL);

	return () => window.clearInterval(intervalId);
}

function bootLibraryRemoveLuaTest(): void {
	const popupManager = getPopupManager();
	if (!popupManager) return;

	const startLibraryPopupMonitor = (popup: Popup) => {
		if (popupCleanups.has(popup)) return;
		if (!popup.window?.name.startsWith('SP Desktop_')) return;

		popupCleanups.set(
			popup,
			startLibraryRouteMonitor(popup, () => getMainWindowBrowserManager()?.m_lastLocation),
		);
	};

	const stopLibraryPopupMonitor = (popup: Popup) => {
		popupCleanups.get(popup)?.();
		popupCleanups.delete(popup);
		if (popup.window) removeHubcapLibraryElements(popup.window.document);
	};

	const existing = popupManager.GetExistingPopup(DESKTOP_WINDOW_NAME);
	if (existing) startLibraryPopupMonitor(existing);

	popupCreatedUnregister = popupManager.AddPopupCreatedCallback(startLibraryPopupMonitor).Unregister;
	popupDestroyedUnregister = popupManager.AddPopupDestroyedCallback?.(stopLibraryPopupMonitor).Unregister ?? null;
}

export default definePlugin(() => {
	bootLibraryRemoveLuaTest();

	return {
		title: 'Hubcap Plugin',
		icon: <IconsModule.Download />,
		onDismount() {
			popupCreatedUnregister?.();
			popupDestroyedUnregister?.();
			popupCreatedUnregister = null;
			popupDestroyedUnregister = null;
		},
	};
});

Millennium.exposeObj?.({});
