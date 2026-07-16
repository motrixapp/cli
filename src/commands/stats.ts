import { Methods, type StatsResult } from '@motrix/mdxp'
import { rpcCall } from '../client'
import { type CommandIo, emit } from '../command-io'
import { formatStats } from '../output'

export async function runStats(io: CommandIo): Promise<void> {
  const result = await rpcCall<StatsResult>(
    io.endpoint,
    Methods.StatsGet,
    {},
    io.fetchImpl
  )
  emit(io, result, formatStats(result))
}
