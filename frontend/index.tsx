import { definePlugin, IconsModule, Millennium } from '@steambrew/client';

export default definePlugin(() => {
	return {
		title: 'Hubcap Plugin',
		icon: <IconsModule.Download />,
	};
});

Millennium.exposeObj?.({});
