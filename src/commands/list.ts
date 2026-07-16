import { Methods, type TaskListParams, type TaskListResult } from '@motrix/mdxp'
import { rpcCall } from '../client'
import { type CommandIo, emit } from '../command-io'
import { formatTaskList } from '../output'

export interface ListOpts {
  status?: string
  limit?: number
  offset?: number
}

export async function runList(opts: ListOpts, io: CommandIo): Promise<void> {
  const params: TaskListParams = {}
  if (opts.status) params.status = opts.status as TaskListParams['status']
  if (opts.limit !== undefined) params.limit = opts.limit
  if (opts.offset !== undefined) params.offset = opts.offset

  const result = await rpcCall<TaskListResult>(
    io.endpoint,
    Methods.TaskList,
    params,
    io.fetchImpl
  )
  emit(io, result, formatTaskList(result))
}
