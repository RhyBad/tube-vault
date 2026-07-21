import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type {
  ChannelDto,
  ChannelListResponse,
  ChannelVideosResponse,
  DeleteChannelResponse,
  RegisterChannelResponse,
} from '@tubevault/types';
import { z } from 'zod';

// EP-12 patch schema (CR-04): watchLive + the nullable per-channel policy
// overrides, all optional, .strict() preserved. Lives in its own module so the
// parse contract is unit-testable without booting Nest (channel-patch.test.ts).
import { channelPatchSchema } from './channel-patch';
import { ChannelsService, type VideosQuery } from './channels.service';
// The SHARED listing schema (video-query.ts): GET /api/videos parses the same
// shape (plus channelId), so the two listings can never drift on semantics.
import { videosQuerySchema } from './video-query';

const registerBodySchema = z.object({ url: z.string().min(1) });

/**
 * DELETE /api/channels/:id query (CR-06). `?purgeMedia=true` opts into the hard
 * delete; anything absent = the default soft unregister. The literal-enum parse
 * (not z.coerce.boolean, whose `Boolean('false')` is `true`) rejects a bad
 * VALUE (e.g. `?purgeMedia=yes` → 400) while a typo'd KEY simply falls through
 * to the safe, non-destructive unregister.
 */
const deleteChannelQuerySchema = z.object({
  purgeMedia: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

/**
 * Channel registration + browsing (session-guarded by the global APP_GUARD;
 * anonymous callers get 401 JSON automatically). Bodies/queries are
 * zod-validated → 400; engine failures surface as 502 {message, errorKind}
 * from the service; controllers return DTOs only.
 */
@Controller('channels')
export class ChannelsController {
  constructor(@Inject(ChannelsService) private readonly channels: ChannelsService) {}

  @Post()
  async register(@Body() body: unknown): Promise<RegisterChannelResponse> {
    const parsed = registerBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('body must be {url: string}');
    }
    return this.channels.registerChannel(parsed.data.url);
  }

  @Get()
  async list(): Promise<ChannelListResponse> {
    return this.channels.listChannels();
  }

  /**
   * P10 + CR-04: patch one channel. `watchLive` toggles live watching (the live
   * worker's scan input); `qualityCap`/`subtitleMode` set the per-channel
   * download-policy overrides (explicit `null` clears → inherit global). All
   * fields optional (absent = unchanged); a typo'd/unknown key is a 400.
   */
  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: unknown): Promise<ChannelDto> {
    const parsed = channelPatchSchema.safeParse(body);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      throw new BadRequestException(`invalid channel patch: ${details}`);
    }
    return this.channels.updateChannel(id, parsed.data);
  }

  /**
   * CR-06: delete one channel. Default = soft "unregister" (stop collection,
   * KEEP the archive + disk media); `?purgeMedia=true` = hard delete (remove the
   * channel + cascade its videos + wipe on-disk media). 200 + DeleteChannelResponse.
   */
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<DeleteChannelResponse> {
    const parsed = deleteChannelQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException('purgeMedia must be "true" or "false"');
    }
    return this.channels.deleteChannel(id, { purgeMedia: parsed.data.purgeMedia === true });
  }

  @Get(':id/videos')
  async videos(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ChannelVideosResponse> {
    const parsed = videosQuerySchema.safeParse(query);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new BadRequestException(`invalid query: ${details}`);
    }
    return this.channels.listVideos(id, parsed.data as VideosQuery);
  }
}
