import { awaitOperation, type EchoPluginContext, type HostRoute } from 'echo:plugin-sdk';
import { DEFAULT_SETTINGS, SKIN_ID, validateSettings } from './config';

export { DEFAULT_SETTINGS, SKIN_ID, validateSettings } from './config';

export function activate(ctx: EchoPluginContext) {
  const skin = ctx.ui.lyricsPage.registerSkin({
    id: SKIN_ID,
    title: 'Apple Music 风格',
    description: '双栏布局：左侧封面与播放控制，右侧宿主原生逐字歌词。',
    component: 'qml/Skin.qml',
    titlebar: 'host',
    tools: 'host',
    preview: 'preview.jpg',
    settingsComponent: 'qml/SkinSettings.qml',
    defaults: { ...DEFAULT_SETTINGS },
    validate: validateSettings,
  });
  if (!skin) throw new Error(ctx.ui.lyricsPage.errorMessage);

  // 皮肤 QML 没有路由访问；专辑/歌手跳转经插件命令进入宿主真实导航，
  // navigation capability 首次调用时由宿主请求用户授权。
  const detailRoutes: HostRoute[] = ['album-detail', 'artist-detail'];
  ctx.registerCommand('open-detail', (args) => {
    const route = String(args?.name ?? '') as HostRoute;
    const resourceId = String(args?.resourceId ?? '');
    if (!detailRoutes.includes(route) || !resourceId) return null;
    return awaitOperation(ctx.ui.navigation.navigate({ name: route, resourceId })).then(() => true);
  });
}

export function deactivate() {}
