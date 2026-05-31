import type { NotificationConfig } from './types';

export class NotificationKit {
  private config: NotificationConfig;

  constructor(config: NotificationConfig) {
    this.config = config;
  }

  async pushMessage(title: string, content: string): Promise<void> {
    const tasks: Array<[string, () => Promise<void>]> = [
      ['Telegram', () => this.sendTelegram(title, content)],
      ['DingTalk', () => this.sendDingTalk(title, content)],
      ['Feishu', () => this.sendFeishu(title, content)],
      ['WeCom', () => this.sendWeCom(title, content)],
      ['PushPlus', () => this.sendPushPlus(title, content)],
      ['ServerChan', () => this.sendServerChan(title, content)],
      ['Gotify', () => this.sendGotify(title, content)],
      ['Bark', () => this.sendBark(title, content)],
    ];

    await Promise.all(tasks.map(async ([name, task]) => {
      try {
        await task();
        console.log(`[${name}]: Message push successful!`);
      } catch (error) {
        console.log(`[${name}]: Message push failed! Reason: ${error}`);
      }
    }));
  }

  private async sendTelegram(title: string, content: string): Promise<void> {
    const telegram = this.config.telegram;
    if (!telegram?.enabled || !telegram.botToken || !telegram.chatId) {
      return;
    }

    const message = `<b>${escapeHtml(title)}</b>\n\n${markdownToTelegramHtml(content)}`;
    await postJson(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
      chat_id: telegram.chatId,
      text: message,
      parse_mode: 'HTML',
    });
  }

  private async sendDingTalk(title: string, content: string): Promise<void> {
    const dingding = this.config.dingding;
    if (!dingding?.enabled || !dingding.webhook) {
      return;
    }

    await postJson(dingding.webhook, {
      msgtype: 'text',
      text: { content: `${title}\n${content}` },
    });
  }

  private async sendFeishu(title: string, content: string): Promise<void> {
    const feishu = this.config.feishu;
    if (!feishu?.enabled || !feishu.webhook) {
      return;
    }

    await postJson(feishu.webhook, {
      msg_type: 'interactive',
      card: {
        elements: [{ tag: 'markdown', content, text_align: 'left' }],
        header: { template: 'blue', title: { content: title, tag: 'plain_text' } },
      },
    });
  }

  private async sendWeCom(title: string, content: string): Promise<void> {
    const weixin = this.config.weixin;
    if (!weixin?.enabled || !weixin.webhook) {
      return;
    }

    await postJson(weixin.webhook, {
      msgtype: 'text',
      text: { content: `${title}\n${content}` },
    });
  }

  private async sendPushPlus(title: string, content: string): Promise<void> {
    const pushplus = this.config.pushplus;
    if (!pushplus?.enabled || !pushplus.token) {
      return;
    }

    await postJson('https://www.pushplus.plus/send', {
      token: pushplus.token,
      title,
      content,
      template: 'html',
    });
  }

  private async sendServerChan(title: string, content: string): Promise<void> {
    const serverChan = this.config.serverChan;
    if (!serverChan?.enabled || !serverChan.token) {
      return;
    }

    await postJson(`https://sctapi.ftqq.com/${serverChan.token}.send`, {
      title,
      desp: content,
    });
  }

  private async sendGotify(title: string, content: string): Promise<void> {
    const gotify = this.config.gotify;
    if (!gotify?.enabled || !gotify.url || !gotify.token) {
      return;
    }

    const url = `${gotify.url}?token=${gotify.token}`;
    await postJson(url, {
      title,
      message: content,
      priority: gotify.priority ?? 9,
    });
  }

  private async sendBark(title: string, content: string): Promise<void> {
    const bark = this.config.bark;
    if (!bark?.enabled || !bark.key) {
      return;
    }

    const server = bark.server || 'https://api.day.app';
    await postJson(`${server.replace(/\/+$/, '')}/push`, {
      device_key: bark.key,
      title,
      body: content,
      icon: 'https://anyrouter.top/favicon.ico',
      group: 'AnyRouter',
    });
  }
}

async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

function markdownToTelegramHtml(content: string): string {
  return escapeHtml(content).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
