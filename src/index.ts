import { corsHeaders, handleAdminApi, jsonResponse, renderAdminPage, requireAuth } from './admin';
import { diagnoseWaf, runAllCheckIns } from './checkin';
import { getLocalTimeStr, loadManagedConfig } from './config';
import { NotificationKit } from './notify';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      return renderAdminPage();
    }

    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    const adminResponse = await handleAdminApi(request, env);
    if (adminResponse) {
      return adminResponse;
    }

    if (url.pathname.startsWith('/api/checkin/') && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const indexText = url.pathname.slice('/api/checkin/'.length);
      const targetIndex = Number(indexText);
      if (!Number.isInteger(targetIndex) || targetIndex < 0) {
        return jsonResponse({ success: false, error: 'Invalid account index' }, { status: 400 });
      }

      try {
        const config = await loadManagedConfig(env);
        const result = await runAllCheckIns(env, config, true, { targetIndex });
        return jsonResponse({ success: true, ...result });
      } catch (error) {
        console.log(`[FAILED] Account test trigger error: ${error}`);
        return jsonResponse({ success: false, error: String(error) }, { status: 500 });
      }
    }

    if (url.pathname === '/api/checkin' && request.method === 'POST') {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      try {
        const config = await loadManagedConfig(env);
        const includeDisabled = url.searchParams.get('includeDisabled') === '1';
        const result = await runAllCheckIns(env, config, true, { includeDisabled });
        if (result.needNotify && result.notificationContent.length > 0) {
          await new NotificationKit(config.notifications).pushMessage(
            `AnyRouter 签到通知 [${getLocalTimeStr()}]`,
            result.notificationContent.join('\n\n'),
          );
        }
        return jsonResponse({ success: true, ...result });
      } catch (error) {
        console.log(`[FAILED] Manual trigger error: ${error}`);
        return jsonResponse({ success: false, error: String(error) }, { status: 500 });
      }
    }

    if (url.pathname === '/api/debug-waf' && request.method === 'GET') {
      const authError = await requireAuth(request, env);
      if (authError) {
        return authError;
      }

      const provider = url.searchParams.get('provider') ?? 'anyrouter';
      const config = await loadManagedConfig(env);
      return jsonResponse({ success: true, result: await diagnoseWaf(env, config, provider) });
    }

    return jsonResponse({ success: false, error: 'Not found' }, { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[CRON] Scheduled trigger fired at ${event.cron}`);
    ctx.waitUntil(runScheduledCheckIn(env));
  },
};

async function runScheduledCheckIn(env: Env): Promise<void> {
  try {
    const config = await loadManagedConfig(env);
    const result = await runAllCheckIns(env, config, false);
    if (result.needNotify && result.notificationContent.length > 0) {
      await new NotificationKit(config.notifications).pushMessage(
        `AnyRouter 签到通知 [${getLocalTimeStr()}]`,
        result.notificationContent.join('\n\n'),
      );
    }
    console.log(`[CRON] Completed: ${result.successCount}/${result.totalCount} successful`);
  } catch (error) {
    console.log(`[CRON] Error: ${error}`);
    const config = await loadManagedConfig(env);
    await new NotificationKit(config.notifications).pushMessage('AnyRouter 签到异常', `定时签到执行失败：${String(error)}`);
  }
}
