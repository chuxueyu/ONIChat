// From https://github.com/Wjghj-Project/Chatbot-SILI/blob/master/core/src/modules/discordLink.js

import assert from 'assert';
import { Context, Session } from 'koishi';
import { DiscordBot } from 'koishi-adapter-discord';
import {} from 'koishi-adapter-onebot';
import { TelegramBot } from 'koishi-adapter-telegram';
import { Logger, segment } from 'koishi-utils';
import fs from 'fs';

const logger = new Logger('partyLinePhone');

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

type QQConfigStrict = {
  platform: 'onebot';
  atOnly: boolean;
  usePrefix: true;
  msgPrefix: string;
  channelId: string;
  botId: string;
};
export type QQConfig = Optional<QQConfigStrict, 'msgPrefix' | 'atOnly'>;

type DiscordConfigStrict = {
  platform: 'discord';
  atOnly: boolean;
  usePrefix: boolean;
  msgPrefix: string;
  channelId: string;
  guildId: string;
  botId: string;
  webhookID: string;
  webhookToken: string;
};
export type DiscordConfig = Optional<
  DiscordConfigStrict,
  'msgPrefix' | 'usePrefix' | 'atOnly'
>;

export type TLConfigStrict = {
  platform: 'telegram';
  atOnly: boolean;
  usePrefix: true;
  msgPrefix: string;
  channelId: string;
  botId: string;
};
export type TLConfig = Optional<TLConfigStrict, 'msgPrefix' | 'atOnly'>;

const ptConfigDefault = {
  onebot: {
    platform: 'onebot',
    atOnly: false,
    msgPrefix: '[QQ]',
    usePrefix: true,
  },
  discord: {
    platform: 'discord',
    atOnly: false,
    msgPrefix: '[DC]',
    usePrefix: false,
  },
  telegram: {
    platform: 'telegram',
    atOnly: false,
    msgPrefix: '[TL]',
    usePrefix: true,
  },
};

export type LinkConfig = (QQConfig | DiscordConfig | TLConfig)[];
export type channelConfigStrict =
  | QQConfigStrict
  | DiscordConfigStrict
  | TLConfigStrict;
export type LinkConfigStrict = channelConfigStrict[];
export type Config = {
  /**
   * number of recent messages kept in memory for reply and deletion
   * @defaultValue 1000
   */
  recent?: number;
  links: LinkConfig[];
};

type RelayedMsgs = {
  channelId: string;
  botId: string;
  msgId: string;
}[];

/**
 * Recent message storage
 */
class RecentMsgs {
  // channelId => messageId => relayedMsgs
  msgs: Record<
    string,
    {
      recent: string[];
      record: Record<string, RelayedMsgs>;
    }
  > = {};

  // channelId => messageId => orig message
  msgMap: Record<string, Record<string, { channelId: string; msgId: string }>> =
    {};

  /**
   * 获取一条消息的所有被转发版本
   * @param channelId 这条消息的频道（带平台）
   * @param msgId 这图消息的 id
   * @returns 这条消息的所有被转发记录
   */
  get(channelId: string, msgId: string): RelayedMsgs | undefined {
    return this.msgs[channelId]?.record[msgId];
  }

  /**
   * 获取一条被转发的消息的原始消息
   * @param channelId 被转发的频道（带平台）
   * @param msgId 被转发后消息的 id
   */
  getOrigin(
    channelId: string,
    msgId: string,
  ): { channelId: string; msgId: string } | undefined {
    return this.msgMap[channelId]?.[msgId];
  }

  /**
   * 保存转发记录
   * @param channelId 原消息频道（带平台）
   * @param msgId 原消息 id
   * @param relayed 转发记录
   */
  push(channelId: string, msgId: string, relayed: RelayedMsgs): void {
    if (!this.msgs[channelId]) {
      this.msgs[channelId] = { recent: [], record: {} };
    }
    this.msgs[channelId].recent.push(msgId);
    this.msgs[channelId].record[msgId] = relayed;

    for (const rMsg of relayed) {
      if (!this.msgMap[rMsg.channelId]) this.msgMap[rMsg.channelId] = {};
      this.msgMap[rMsg.channelId][rMsg.msgId] = { channelId, msgId };
    }
    if (this.msgs[channelId].recent.length > this.limit) {
      const deletedMsgId = this.msgs[channelId]?.recent?.shift();
      if (deletedMsgId) {
        const records = this.msgs[channelId].record[deletedMsgId];
        records.forEach((r) => {
          if (this.msgMap[r.channelId]?.[r.msgId])
            delete this.msgMap[r.channelId][r.msgId];
        });
        delete this.msgs[channelId].record[deletedMsgId];
      }
    }
    logger.debug('添加消息记录', channelId, msgId, relayed);
  }

  constructor(public limit: number) {}
}

export function apply(ctx: Context, config: Config): void {
  config.links = config.links.filter((l) => l.length >= 2);
  config.recent = config.recent || 1000;
  const recentMsgs = new RecentMsgs(config.recent);

  const webhookIDs: string[] = config.links.flatMap((link) => {
    const ids: string[] = [];
    for (const channel of link) {
      if (channel.platform == 'discord') ids.push(channel.webhookID);
    }
    return ids;
  });
  ctx // 不响应转发的DC消息（有些还是过滤不掉所以后面有重新检测）
    .middleware((session, next) => {
      if (session.platform == 'discord') {
        const userId = session?.author?.userId;
        if (userId && webhookIDs.includes(userId)) return;
      }
      return next();
    }, true /* true 表示这是前置中间件 */);

  const prefixes: string[] = config.links.flatMap((link) =>
    link.map(
      (channel) =>
        channel.msgPrefix || ptConfigDefault[channel.platform].msgPrefix,
    ),
  );

  config.links.forEach((linked) => {
    linked.forEach((partialChannelConf, i) => {
      const channelPlatform: 'onebot' | 'discord' | 'telegram' =
        partialChannelConf.platform;
      const source: channelConfigStrict = {
        ...ptConfigDefault[channelPlatform],
        ...partialChannelConf,
      };
      const destinations: channelConfigStrict[] = linked
        .filter((_, j) => i !== j)
        .map((d) => ({ ...ptConfigDefault[d.platform], ...d }));

      type relaySession = Session.Payload<'send' | 'message', unknown>;
      const onRelay = async (session: relaySession): Promise<void> => {
        const platform = session.platform;
        if (!platform || !session.content) return;
        // 不响应转发的DC消息
        if (
          session?.author?.userId &&
          webhookIDs.includes(session?.author?.userId)
        )
          return;
        const relayed: RelayedMsgs = [];
        for (const dest of destinations) {
          try {
            const msgId = await relayMsg(
              ctx,
              session,
              source,
              dest,
              prefixes,
              recentMsgs,
            );
            const cid = `${dest.platform}:${dest.channelId}`;
            const botId = dest.botId;
            if (msgId) relayed.push({ channelId: cid, botId, msgId });
          } catch (e) {
            logger.warn('转发消息出错', e);
          }
        }
        if (session.messageId) {
          recentMsgs.push(
            `${source.platform}:${source.channelId}`,
            session.messageId,
            relayed,
          );
        }
      };

      ctx // 收到消息
        .channel(source.channelId)
        .on('message/group', onRelay);
      ctx // 自己发消息
        .channel(source.channelId)
        .on('send/group', onRelay);
      switch (source.platform) {
        case 'onebot':
          ctx // QQ 撤回消息
            .platform('onebot' as never)
            .channel(source.channelId)
            .on('message-deleted/group', (session) => {
              const deletedMsg = session.messageId;
              const channelId = session.channelId;
              const platform = session.platform;
              if (!deletedMsg || !channelId || !platform) return;
              const relayed = recentMsgs.get(
                `${platform}:${channelId}`,
                deletedMsg,
              );
              if (!relayed) return;
              relayed.forEach((record) => {
                const platform = record.channelId.split(':')[0];
                const bot = ctx.getBot(platform as never, record.botId);
                bot.deleteMessage(record.channelId, record.msgId);
                logger.info('撤回消息：', record.channelId, record.msgId);
              });
            });
          break;
      }
    });
    logger.success(
      linked.map((c) => `${c.platform}:${c.channelId}`).join(' ⇿ '),
    );
  });
}

async function relayMsg(
  ctx: Context,
  session: Session,
  source: channelConfigStrict,
  dest: channelConfigStrict,
  prefixes: string[],
  recentMsgs: RecentMsgs,
): Promise<string | undefined> {
  const author = session.author;
  const content = session.content;
  const channelId = session.channelId;
  const channelIdExtended = `${session.platform}:${channelId}`;
  if (!content || !author || !channelId || !session.platform) throw Error();
  const aliasDest: string = dest.platform == 'onebot' ? 'qq' : dest.platform;
  if (new RegExp(`(%disabled%|__no${aliasDest}__)`, 'i').test(content)) return;
  // 不转发转发的消息
  if (author.isBot !== false && prefixes.some((p) => content.startsWith(p)))
    return;

  const parsed = segment.parse(content);
  if (source.atOnly && !mentioned(parsed, source.botId)) return;
  let sender = author.nickname || author.username || '';
  sender += author.discriminator ? `#${author.discriminator}` : '';
  sender += !author.discriminator && author.userId ? ` (${author.userId})` : '';

  const prefix = dest.usePrefix ? source.msgPrefix : '';
  let lastType = '';
  let foundQuoteMsg: string | undefined;
  const processed: segment[] = parsed.map((seg) => {
    const onErr = function (msg: string): segment {
      logger.warn(msg, seg);
      return seg;
    };
    const lastTypeNow = lastType;
    lastType = seg.type;
    switch (seg.type) {
      case 'text':
      case 'image':
        return seg;
      case 'quote': {
        const referred = seg.data['id'];
        if (!referred) return onErr('引用消息段无被引用消息');
        const relayed = recentMsgs.get(channelIdExtended, referred);
        if (relayed) {
          // 引用的是一则本地消息（但大概率被转发过）
          const relayInDest = relayed.filter(
            (r) => r.channelId == `${dest.platform}:${dest.channelId}`,
          )[0];
          if (relayInDest) {
            foundQuoteMsg = relayInDest.msgId;
            return { ...seg, data: { id: relayInDest.msgId } };
          } else return onErr('找不到目标频道的原消息转发');
        } else {
          // 引用的是一则从其他频道而来的消息
          const orig = recentMsgs.getOrigin(channelIdExtended, referred);
          if (!orig)
            return onErr(
              `找不到引用消息引用源 ${channelIdExtended} ${referred}`,
            );
          if (orig.channelId == `${dest.platform}:${dest.channelId}`) {
            foundQuoteMsg = orig.msgId;
            return { ...seg, data: { id: orig.msgId } };
          } else {
            const relayed = recentMsgs.get(orig.channelId, orig.msgId);
            if (!relayed) return onErr('引用消息源未被转发');
            const relayInDest = relayed.filter(
              (r) => r.channelId == `${dest.platform}:${dest.channelId}`,
            )[0];
            if (!relayInDest) return onErr('引用消息源未被转发到目标频道');
            foundQuoteMsg = relayInDest.msgId;
            return { ...seg, data: { id: relayInDest.msgId } };
          }
        }
      }
      case 'at':
        if (seg.data.id == source.botId)
          return { type: 'text', data: { content: '' } };
        // QQ 的 quote 后必自带一个 at
        if (source.platform == 'onebot' && lastTypeNow == 'quote')
          return { type: 'text', data: { content: '' } };
        // 平台不同 at 或非单体 at 即转化为纯文本
        const escape =
          source.platform != dest.platform ||
          seg?.data?.role ||
          seg?.data?.type;
        if (escape) {
          const atTarget =
            seg?.data?.name ||
            seg?.data?.id ||
            seg?.data?.role ||
            seg?.data?.type ||
            '未知用户';
          return { type: 'text', data: { content: `@${atTarget}` } };
        }
      default:
        return seg;
    }
  });
  const bot = ctx.getBot(dest.platform, dest.botId);
  const relayedText = segment.join(processed);
  try {
    let msgId: string;

    if (dest.platform == 'discord') {
      assert(bot.platform == 'discord');
      const whCard = [];
      if (foundQuoteMsg) {
        whCard.push({
          description: `[被回复的消息](https://discord.com/channels/${dest.guildId}/${dest.channelId}/${foundQuoteMsg})`,
        });
      }
      const dcBot = bot as unknown as DiscordBot;
      const avatar_url =
        source.platform == 'onebot'
          ? `http://q1.qlogo.cn/g?b=qq&nk=${author.userId}&s=640`
          : author.avatar;
      msgId = await dcBot.$executeWebhook(
        dest.webhookID,
        dest.webhookToken,
        {
          content: relayedText,
          username: prefix + sender,
          avatar_url,
          embeds: whCard,
        },
        true,
      );
    } else if (dest.platform == 'telegram') {
      const tlBot = bot as unknown as TelegramBot;
      msgId = await telegramSend(
        tlBot,
        dest.channelId,
        `${prefix}${sender}：\n${relayedText}`,
      );
    } else {
      msgId = await bot.sendMessage(
        dest.channelId,
        `${prefix}${sender}：\n${relayedText}`,
      );
    }

    logger.info(
      '⇿',
      `${source.msgPrefix} 信息已推送到 ${dest.msgPrefix}`,
      sender,
      session.content,
    );
    return msgId;
  } catch (error) {
    logger.warn(
      '信息转发失败',
      `${source.msgPrefix} ⇿ ${dest.msgPrefix}`,
      sender,
      session.content,
      error,
    );
  }
}

const mentioned = (segs: segment.Chain, botId: string): boolean =>
  segs.some((seg) => seg.type == 'at' && seg.data.id == botId);

// add replay support for telegram adapter
async function telegramSend(
  bot: TelegramBot,
  channelID: string,
  content: string,
): Promise<string> {
  const chain = segment.parse(content);
  const payload = { channelID, caption: '', photo: '' };
  let replyToMessageId;
  let result;
  for (const node of chain) {
    if (node.type === 'text') {
      payload.caption += node.data.content;
    } else if (node.type === 'image') {
      if (payload.photo) {
        result = await bot.get('sendPhoto', ...maybeFile(payload, 'photo'));
        payload.caption = '';
        payload.photo = '';
      }
      payload.photo = node.data.url || node.data.file;
    } else if (node.type == 'quote') {
      replyToMessageId = node.data.id;
    } else {
      payload.caption += '[Unsupported message]';
    }
  }
  if (payload.photo) {
    result = await bot.get('sendPhoto', ...maybeFile(payload, 'photo'));
    payload.caption = '';
    payload.photo = '';
  } else if (payload.caption) {
    const params: Record<string, any> = {
      chatId: channelID,
      text: payload.caption,
    };
    if (replyToMessageId) params.replyToMessageId = replyToMessageId;
    result = await bot.get('sendMessage', params);
  }

  if (result?.messageId) return `${result.messageId}`;
  throw new Error('Send telegram message field');
}

// add replay support for telegram adapter
function maybeFile(
  payload: Record<string, any>,
  field: string,
): (string | Record<string, any> | undefined)[] {
  if (!payload[field]) return [payload];
  let content;
  const [schema, data] = payload[field].split('://');
  if (['base64', 'file'].includes(schema)) {
    content =
      schema === 'base64'
        ? Buffer.from(data, 'base64')
        : fs.createReadStream(data);
    delete payload[field];
  }
  return [payload, field, content];
}
