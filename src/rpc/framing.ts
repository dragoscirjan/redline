/** Both internal workers and public RPC use the same bounded byte framing, not the same protocol. */
export { frame, FrameReader, FrameWriter, FramingError } from '../transport/framing.ts';
