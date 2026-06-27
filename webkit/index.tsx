import { callable } from '@steambrew/webkit';

type BackendResult = {
	success: boolean;
	error?: string;
	appId?: string;
	displayAppId?: string;
	exists?: boolean;
	removed?: boolean;
	kind?: string;
	zipPath?: string;
	keptDownloadPath?: string;
	luaDir?: string;
	luaFiles?: string[];
	manifestDir?: string;
	manifestFiles?: string[];
	available?: boolean;
	status?: string;
	message?: string;
	updateInProgress?: boolean;
	dailyUsage?: number;
	dailyLimit?: number;
	roleDailyLimit?: number;
	apiKeyUsageCount?: number;
	apiKeyExpiresAt?: string;
	autoUpdateEnabled?: boolean;
	canMakeRequests?: boolean;
	username?: string;
	timestamp?: string;
};

const downloadLua = callable<[{ app_id: string }], string>('download_lua_for_app');
const checkLua = callable<[{ app_id: string }], string>('check_lua_for_app');
const deleteLua = callable<[{ app_id: string }], string>('delete_lua_for_app');
const checkLuaStatus = callable<[{ app_id: string }], string>('check_lua_status_for_app');
const checkHubcapTool = callable<[Record<string, never>], string>('check_hubcap_tool');
const checkHubcapLimit = callable<[Record<string, never>], string>('check_hubcap_limit');

const BUTTON_ID = 'hubcap-lua-download-button';
const LIMIT_BUTTON_ID = 'hubcap-limit-check-button';
const STATUS_ID = 'hubcap-lua-download-status';
const BAR_ID = 'hubcap-lua-action-bar';
const LEFT_GROUP_ID = 'hubcap-lua-left-actions';
const RIGHT_GROUP_ID = 'hubcap-lua-right-actions';
const LIBRARY_BUTTON_ID = 'hubcap-go-library-button';
const WARNING_ID = 'hubcap-denuvo-warning';

const statusCache = new Map<string, { checkedAt: number; result: BackendResult }>();
let limitRefreshInFlight = false;

function getAppIdFromLocation(): string | null {
	const match = window.location.pathname.match(/\/app\/(\d+)(?:\/|$)/);
	return match?.[1] ?? null;
}

async function resolveAppId(): Promise<{ appId: string; visibleAppId: string; parentName?: string; isDlc: boolean } | null> {
	const visibleAppId = getAppIdFromLocation();
	if (!visibleAppId) return null;

	try {
		const response = await fetch(`https://store.steampowered.com/api/appdetails?appids=${visibleAppId}&filters=basic`, {
			credentials: 'omit',
		});
		const payload = await response.json();
		const data = payload?.[visibleAppId]?.data;
		const fullGameAppId = data?.type === 'dlc' ? data?.fullgame?.appid : null;

		if (fullGameAppId && /^\d+$/.test(String(fullGameAppId))) {
			return {
				appId: String(fullGameAppId),
				visibleAppId,
				parentName: data?.fullgame?.name,
				isDlc: true,
			};
		}
	} catch (error) {
		console.warn('[HubcapPlugin] Could not resolve Steam appdetails; using visible app id.', error);
	}

	return { appId: visibleAppId, visibleAppId, isDlc: false };
}

function parseBackendResult(raw: string): BackendResult {
	try {
		return JSON.parse(raw) as BackendResult;
	} catch {
		return { success: false, error: raw || 'Unexpected empty backend response' };
	}
}

function setStatus(message: string, tone: 'idle' | 'loading' | 'success' | 'error' = 'idle') {
	const status = document.getElementById(STATUS_ID);
	if (!status) return;

	status.textContent = message;
	status.dataset.tone = tone;
}

function setTemporaryStatus(message: string, tone: 'success' | 'error' | 'loading') {
	const status = document.getElementById(STATUS_ID);
	if (!status) return;

	status.dataset.activeMessage = 'true';
	setStatus(message, tone);
	window.setTimeout(() => {
		status.dataset.activeMessage = 'false';
		void refreshButtonState();
	}, 4000);
}

function injectStyles() {
	if (document.getElementById('hubcap-lua-download-styles')) return;

	const style = document.createElement('style');
	style.id = 'hubcap-lua-download-styles';
	style.textContent = `
		#${BUTTON_ID},
		#${LIMIT_BUTTON_ID} {
			background: linear-gradient(180deg, #67c1f5 0%, #417a9b 100%);
			border: 0;
			border-radius: 2px;
			color: #d6f4ff;
			cursor: pointer;
			font-family: Arial, Helvetica, sans-serif;
			font-size: 14px;
			line-height: 32px;
			min-height: 32px;
			padding: 0 14px;
			white-space: nowrap;
		}

		#${LIMIT_BUTTON_ID} {
			min-width: 132px;
		}

		#${LIBRARY_BUTTON_ID} {
			background: rgba(103, 193, 245, 0.18);
			border: 1px solid rgba(103, 193, 245, 0.35);
			border-radius: 2px;
			color: #d6f4ff;
			cursor: pointer;
			display: none;
			font-family: Arial, Helvetica, sans-serif;
			font-size: 14px;
			line-height: 30px;
			min-height: 32px;
			padding: 0 14px;
			white-space: nowrap;
		}

		#${LIBRARY_BUTTON_ID}:hover {
			background: rgba(103, 193, 245, 0.3);
			color: #fff;
		}

		#${LIBRARY_BUTTON_ID}[data-visible="true"] {
			display: inline-flex;
			align-items: center;
		}

		#${BAR_ID} {
			align-items: center;
			display: flex;
			gap: 10px;
			justify-content: space-between;
			margin: 8px 0 18px;
			min-height: 34px;
			width: 100%;
		}

		#${LEFT_GROUP_ID},
		#${RIGHT_GROUP_ID} {
			align-items: center;
			display: flex;
			gap: 10px;
			min-width: 0;
		}

		#${LEFT_GROUP_ID} {
			flex: 1 1 auto;
		}

		#${RIGHT_GROUP_ID} {
			flex: 0 0 auto;
			margin-left: auto;
		}

		#${BUTTON_ID}:hover,
		#${LIMIT_BUTTON_ID}:hover {
			background: linear-gradient(180deg, #8ed9ff 0%, #4f9ec8 100%);
			color: #fff;
		}

		#${BUTTON_ID}:disabled,
		#${LIMIT_BUTTON_ID}:disabled {
			cursor: default;
			filter: grayscale(0.35);
			opacity: 0.72;
		}

		#${BUTTON_ID}[data-hubcap-state="checking"] {
			align-items: center;
			display: inline-flex;
			gap: 8px;
		}

		#${BUTTON_ID}[data-hubcap-state="checking"]::before {
			animation: hubcap-spin 0.8s linear infinite;
			border: 2px solid rgba(214, 244, 255, 0.35);
			border-top-color: #d6f4ff;
			border-radius: 50%;
			content: "";
			height: 12px;
			width: 12px;
		}

		@keyframes hubcap-spin {
			to {
				transform: rotate(360deg);
			}
		}

		#${STATUS_ID} {
			color: #acdbf5;
			display: inline-flex;
			font-size: 12px;
			margin-left: 10px;
			max-width: 520px;
			overflow: hidden;
			text-overflow: ellipsis;
			vertical-align: middle;
			white-space: nowrap;
		}

		#${STATUS_ID}[data-tone="error"] {
			color: #ff9b8f;
		}

		#${STATUS_ID}[data-tone="success"] {
			color: #a4d007;
		}

		#${WARNING_ID} {
			color: #f7c46c;
			display: none;
			font-size: 12px;
			margin-left: 2px;
			white-space: nowrap;
		}

		#${WARNING_ID}[data-visible="true"] {
			display: inline-flex;
		}

		#${BUTTON_ID}.hubcap-floating {
			position: fixed;
			right: 26px;
			top: 154px;
			z-index: 999999;
			box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
		}

		#${STATUS_ID}.hubcap-floating {
			background: rgba(20, 31, 44, 0.96);
			border: 1px solid rgba(103, 193, 245, 0.35);
			border-radius: 3px;
			max-width: 460px;
			padding: 6px 8px;
			position: fixed;
			right: 26px;
			top: 192px;
			z-index: 999999;
		}
	`;
	document.head.appendChild(style);
}

function findButtonHost(): HTMLElement | null {
	const title = document.querySelector('.apphub_AppName');
	if (title?.parentElement) {
		return title.parentElement;
	}

	const highlight = document.querySelector('#game_highlights');
	if (highlight?.parentElement) {
		return highlight.parentElement;
	}

	return null;
}

function hasDenuvoWarning(): boolean {
	const pageText = document.body?.innerText ?? '';
	return /denuvo|anti[-\s]?tamper/i.test(pageText);
}

function refreshDenuvoWarning() {
	const warning = document.getElementById(WARNING_ID);
	if (!warning) return;

	const detected = hasDenuvoWarning();
	warning.dataset.visible = detected ? 'true' : 'false';
	warning.textContent = detected ? 'Warning: Denuvo / anti-tamper detected' : '';
	warning.title = 'Steam page mentions Denuvo or anti-tamper. Download is still allowed.';
}

async function goToLibrary() {
	const resolved = await resolveAppId();
	if (!resolved) {
		setStatus('Open a Steam app page first.', 'error');
		return;
	}

	window.location.href = `steam://nav/games/details/${resolved.appId}`;
}

async function refreshHubcapLimit(options: { silent?: boolean } = {}) {
	const button = document.getElementById(LIMIT_BUTTON_ID) as HTMLButtonElement | null;
	if (!button || limitRefreshInFlight) return;

	const previousText = button.textContent || 'Check Hubcap Limit';
	limitRefreshInFlight = true;
	button.disabled = true;
	if (!options.silent) {
		button.textContent = 'Checking...';
	}

	try {
		const result = parseBackendResult(await checkHubcapLimit({}));
		if (!result.success) {
			throw new Error(result.error ?? 'Could not check Hubcap limit.');
		}

		const usage = Number(result.dailyUsage);
		const limit = Number(result.dailyLimit);
		if (!Number.isFinite(usage) || !Number.isFinite(limit)) {
			throw new Error('Hubcap usage response was missing daily usage.');
		}

		button.textContent = `${usage}/${limit}`;
		const expiryDays = getDaysUntil(result.apiKeyExpiresAt);
		button.title = [
			result.username ? `Hubcap user: ${result.username}` : '',
			`Daily usage: ${usage}/${limit}`,
			expiryDays !== null ? `API key expires in ${expiryDays} day${expiryDays === 1 ? '' : 's'}` : '',
		].filter(Boolean).join('\n');
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		button.textContent = 'Limit Error';
		button.title = message;
		setTemporaryStatus(message, 'error');
		window.setTimeout(() => {
			button.textContent = previousText;
		}, 4000);
	} finally {
		button.disabled = false;
		limitRefreshInFlight = false;
	}
}

async function handleLimitClick() {
	await refreshHubcapLimit();
}

function getDaysUntil(dateValue?: string): number | null {
	if (!dateValue) return null;

	const expiresAt = new Date(dateValue.endsWith('Z') ? dateValue : `${dateValue}Z`);
	const expiresTime = expiresAt.getTime();
	if (!Number.isFinite(expiresTime)) return null;

	const millisecondsPerDay = 24 * 60 * 60 * 1000;
	return Math.max(0, Math.ceil((expiresTime - Date.now()) / millisecondsPerDay));
}

async function handleClick(button: HTMLButtonElement) {
	const resolved = await resolveAppId();
	if (!resolved) {
		setStatus('Open a Steam app page first.', 'error');
		return;
	}

	if (button.dataset.hubcapState === 'unavailable') {
		return;
	}

	const state = button.dataset.hubcapState === 'remove' ? 'remove' : 'download';
	const appId = resolved.appId;
	button.disabled = true;
	button.textContent = state === 'remove' ? 'Removing Lua...' : 'Downloading Lua...';
	setStatus(`Preparing HubcapTool config for app ${appId}...`, 'loading');

	try {
		const check = parseBackendResult(await checkHubcapTool({}));
		if (!check.success) {
			throw new Error(check.error ?? 'HubcapTool is not configured.');
		}

		const actionLabel = resolved.isDlc ? `parent game ${appId}` : `app ${appId}`;
		setStatus(`${state === 'remove' ? 'Removing' : 'Downloading'} Lua for ${actionLabel}...`, 'loading');
		const result = parseBackendResult(await (state === 'remove' ? deleteLua({ app_id: appId }) : downloadLua({ app_id: appId })));
		if (!result.success) {
			throw new Error(result.error ?? `${state === 'remove' ? 'Remove' : 'Download'} failed.`);
		}

		if (state === 'remove') {
			setTemporaryStatus(result.removed ? 'Removed!' : 'Nothing to remove.', 'success');
		} else {
			setTemporaryStatus('Added!', 'success');
			void refreshHubcapLimit({ silent: true });
		}
		await refreshButtonState();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		setTemporaryStatus(message, 'error');
	} finally {
		statusCache.delete(appId);
		button.disabled = false;
		await refreshButtonState();
	}
}

async function getCachedLuaStatus(appId: string): Promise<BackendResult> {
	const cached = statusCache.get(appId);
	if (cached && Date.now() - cached.checkedAt < 60000) {
		return cached.result;
	}

	const result = parseBackendResult(await checkLuaStatus({ app_id: appId }));
	statusCache.set(appId, { checkedAt: Date.now(), result });
	return result;
}

async function refreshButtonState() {
	const button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
	if (!button || (button.disabled && !['checking', 'unavailable'].includes(button.dataset.hubcapState ?? ''))) return;

	const resolved = await resolveAppId();
	if (!resolved) return;

	try {
		const luaResult = parseBackendResult(await checkLua({ app_id: resolved.appId }));

		if (!luaResult.success) {
			throw new Error(luaResult.error ?? 'Could not check Lua state.');
		}

		if (luaResult.exists) {
			button.dataset.hubcapState = 'remove';
			button.textContent = 'Remove Lua';
			button.disabled = false;
		} else {
			const cached = statusCache.get(resolved.appId);
			if (!cached || Date.now() - cached.checkedAt >= 60000) {
				button.dataset.hubcapState = 'checking';
				button.textContent = 'Checking...';
				button.disabled = true;
			}

			const statusResult = await getCachedLuaStatus(resolved.appId);
			if (!statusResult.success) {
				throw new Error(statusResult.error ?? 'Could not check Hubcap status.');
			}

			const isAvailable = statusResult.available === true;
			button.dataset.hubcapState = isAvailable ? 'download' : 'unavailable';
			button.textContent = isAvailable ? 'Download Lua' : 'Lua Unavailable';
			button.disabled = !isAvailable;
		}

		button.title = resolved.isDlc
			? `DLC page detected. Using parent game ${resolved.appId}${resolved.parentName ? ` (${resolved.parentName})` : ''}.`
			: `Using Steam app ${resolved.appId}.`;

		const libraryButton = document.getElementById(LIBRARY_BUTTON_ID) as HTMLButtonElement | null;
		if (libraryButton) {
			libraryButton.dataset.visible = luaResult.exists ? 'true' : 'false';
			libraryButton.title = resolved.isDlc
				? `Open base game ${resolved.appId}${resolved.parentName ? ` (${resolved.parentName})` : ''} in Library.`
				: `Open app ${resolved.appId} in Library.`;
		}

		const status = document.getElementById(STATUS_ID);
		if (resolved.isDlc && status?.dataset.activeMessage !== 'true') {
			setStatus(`DLC detected: using base game ${resolved.appId}${resolved.parentName ? ` - ${resolved.parentName}` : ''}`);
		} else if (!resolved.isDlc && status?.dataset.activeMessage !== 'true') {
			setStatus('');
		}
	} catch (error) {
		if (button) {
			button.dataset.hubcapState = 'download';
			button.textContent = 'Download Lua';
		}
		const libraryButton = document.getElementById(LIBRARY_BUTTON_ID) as HTMLButtonElement | null;
		if (libraryButton) {
			libraryButton.dataset.visible = 'false';
		}
		console.warn('[HubcapPlugin] Hubcap state check failed.', error);
	}
}

function injectButton() {
	const appId = getAppIdFromLocation();
	const existing = document.getElementById(BUTTON_ID);

	if (!appId) {
		document.getElementById(BAR_ID)?.remove();
		return;
	}

	if (existing) return;

	injectStyles();

	const bar = document.createElement('div');
	bar.id = BAR_ID;

	const leftGroup = document.createElement('div');
	leftGroup.id = LEFT_GROUP_ID;

	const rightGroup = document.createElement('div');
	rightGroup.id = RIGHT_GROUP_ID;

	const button = document.createElement('button');
	button.id = BUTTON_ID;
	button.type = 'button';
	button.textContent = 'Checking...';
	button.dataset.hubcapState = 'checking';
	button.disabled = true;
	button.addEventListener('click', () => handleClick(button));

	const libraryButton = document.createElement('button');
	libraryButton.id = LIBRARY_BUTTON_ID;
	libraryButton.type = 'button';
	libraryButton.textContent = 'Go to Library';
	libraryButton.dataset.visible = 'false';
	libraryButton.addEventListener('click', () => {
		void goToLibrary();
	});

	const status = document.createElement('span');
	status.id = STATUS_ID;
	status.dataset.tone = 'idle';

	const warning = document.createElement('span');
	warning.id = WARNING_ID;
	warning.dataset.visible = 'false';

	const limitButton = document.createElement('button');
	limitButton.id = LIMIT_BUTTON_ID;
	limitButton.type = 'button';
	limitButton.textContent = 'Checking Limit...';
	limitButton.title = 'Check daily Hubcap API usage.';
	limitButton.addEventListener('click', () => {
		void handleLimitClick();
	});

	leftGroup.appendChild(button);
	leftGroup.appendChild(libraryButton);
	leftGroup.appendChild(status);
	leftGroup.appendChild(warning);
	rightGroup.appendChild(limitButton);
	bar.appendChild(leftGroup);
	bar.appendChild(rightGroup);

	const host = findButtonHost();
	if (host) {
		const highlight = document.querySelector('#game_highlights');
		if (highlight && highlight.parentElement === host) {
			host.insertBefore(bar, highlight);
		} else {
			host.appendChild(bar);
		}
		void refreshButtonState();
		void refreshHubcapLimit({ silent: true });
		refreshDenuvoWarning();
		return;
	}

	button.classList.add('hubcap-floating');
	status.classList.add('hubcap-floating');
	document.body.appendChild(bar);
	void refreshButtonState();
	void refreshHubcapLimit({ silent: true });
	refreshDenuvoWarning();
}

export default async function WebkitMain() {
	injectButton();

	let lastUrl = window.location.href;
	setInterval(() => {
		if (window.location.href !== lastUrl) {
			lastUrl = window.location.href;
			setTimeout(() => {
				injectButton();
				void refreshButtonState();
				refreshDenuvoWarning();
			}, 250);
			return;
		}
		injectButton();
		refreshDenuvoWarning();
	}, 1000);

	setInterval(() => {
		void refreshButtonState();
		refreshDenuvoWarning();
	}, 2500);
}
