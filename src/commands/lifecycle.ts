import { Methods, type OkResult } from '@motrix/mdxp'
import { rpcCall } from '../client'
import { type CommandIo, emit } from '../command-io'

export async function runPause(taskId: string, io: CommandIo): Promise<void> {
  const result = await rpcCall<OkResult>(
    io.endpoint,
    Methods.TaskPause,
    { taskId },
    io.fetchImpl
  )
  emit(io, result, `paused ${taskId}`)
}

export async function runResume(taskId: string, io: CommandIo): Promise<void> {
  const result = await rpcCall<OkResult>(
    io.endpoint,
    Methods.TaskResume,
    { taskId },
    io.fetchImpl
  )
  emit(io, result, `resumed ${taskId}`)
}

export interface RemoveOpts {
  deleteFiles?: boolean
}

export async function runRemove(
  taskId: string,
  opts: RemoveOpts,
  io: CommandIo
): Promise<void> {
  const params = {
    taskId,
    ...(opts.deleteFiles ? { deleteFiles: true } : {}),
  }
  const result = await rpcCall<OkResult>(
    io.endpoint,
    Methods.TaskRemove,
    params,
    io.fetchImpl
  )
  emit(io, result, `removed ${taskId}`)
}
