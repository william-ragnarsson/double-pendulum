// The slice of Mediabunny that video export needs. Importing this module
// dynamically (rather than 'mediabunny' itself) lets the bundler tree-shake
// the demuxers, decoders and other formats out of the lazily loaded chunk.
export {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
