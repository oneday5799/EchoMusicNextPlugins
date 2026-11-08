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
  // 评论/分享入口上移到宿主右缘歌词工具列（对齐旧 web 版插件的 side-tools 传送
  // 按钮）；皮肤信息行相应只保留收藏与更多外观。插入点选重置偏移的常驻槽位，
  // 不受"译/音/复制"组有歌词才可见的显隐影响；宿主注入 page 视图上下文，
  // 命令通道与皮肤信息行一致（SideActions.qml 声明 page 属性即收）。
  const sideActions = ctx.ui.parts.contribute(
    'side-actions',
    { key: 'lyricOffsetAction-0', surface: 'playback' },
    {
      operation: 'insert',
      position: 'after',
      component: 'qml/SideActions.qml',
      layout: { preferredWidth: 36, preferredHeight: 80 },
    },
  );
  if (!sideActions) throw new Error(ctx.ui.parts.errorMessage);

  const detailRoutes: HostRoute[] = ['album-detail', 'artist-detail'];
  ctx.registerCommand('open-detail', (args) => {
    const route = String(args?.name ?? '') as HostRoute;
    const resourceId = String(args?.resourceId ?? '');
    if (!detailRoutes.includes(route) || !resourceId) return null;
    return awaitOperation(ctx.ui.navigation.navigate({ name: route, resourceId })).then(() => true);
  });
}

export function deactivate() {}
