const adjectives = [
  'amber', 'ancient', 'arctic', 'ashen', 'azure', 'bare', 'blazing', 'bold',
  'broken', 'calm', 'cardinal', 'carved', 'celestial', 'cobalt', 'cold',
  'copper', 'crimson', 'crystal', 'dark', 'dawn', 'deep', 'distant', 'drifting',
  'dusk', 'dusty', 'early', 'echo', 'elder', 'empty', 'fading', 'fallen',
  'feral', 'fierce', 'final', 'flint', 'floating', 'fond', 'forgotten', 'frozen',
  'gilded', 'glacial', 'grave', 'hidden', 'hollow', 'humble', 'hungry', 'hushed',
  'indigo', 'inland', 'iron', 'jade', 'jagged', 'keen', 'kindled', 'last',
  'late', 'lean', 'liminal', 'lone', 'lost', 'low', 'lunar', 'mellow',
  'midnight', 'mild', 'misty', 'molten', 'muted', 'narrow', 'nested', 'noble',
  'northern', 'obsidian', 'ochre', 'odd', 'old', 'onyx', 'open', 'outer',
  'pale', 'patient', 'phantom', 'plain', 'quiet', 'raw', 'relic',
  'remote', 'restless', 'rough', 'runic', 'sacred', 'scarlet', 'severe',
  'sharp', 'shifting', 'silent', 'silver', 'slow', 'small', 'smoky', 'soft',
  'solar', 'solemn', 'sparse', 'stark', 'steady', 'still', 'stone', 'strange',
  'subtle', 'sunken', 'swift', 'tidal', 'timber', 'tired', 'torn', 'twilight',
  'verdant', 'violet', 'void', 'wandering', 'warm', 'weathered', 'wild', 'worn',
]

const nouns = [
  'albatross', 'alder', 'antler', 'anvil', 'arc', 'ash', 'atlas', 'axle',
  'basin', 'beacon', 'bedrock', 'birch', 'blade', 'bluff', 'bough', 'bridge',
  'cairn', 'canyon', 'cedar', 'cipher', 'circuit', 'cliff', 'cloud', 'coil',
  'compass', 'conduit', 'cove', 'crane', 'crater', 'creek', 'crest', 'crow',
  'crystal', 'current', 'delta', 'dune', 'echo', 'ember', 'falcon', 'fern',
  'fjord', 'flare', 'flint', 'flux', 'forge', 'fork', 'fossil', 'fox',
  'gale', 'gate', 'glacier', 'glyph', 'gorge', 'granite', 'grove', 'gulf',
  'harbor', 'hawk', 'hearth', 'helix', 'hollow', 'horizon', 'heron', 'hull',
  'ibis', 'inlet', 'iris', 'isle', 'kelp', 'kestrel', 'knoll', 'lantern',
  'larch', 'lattice', 'ledge', 'lens', 'lichen', 'lodge', 'loom', 'lune',
  'lynx', 'mantle', 'marsh', 'marrow', 'mesa', 'mirror', 'moor', 'moss',
  'narwhal', 'needle', 'nexus', 'node', 'oak', 'orbit', 'osprey', 'otter',
  'outcrop', 'owl', 'peak', 'pine', 'prism', 'pulse', 'quarry', 'raven',
  'reef', 'relay', 'ridge', 'rift', 'rook', 'root', 'rover', 'rune',
  'sage', 'schist', 'sedge', 'shard', 'shoal', 'shore', 'signal', 'slate',
  'solstice', 'spire', 'spring', 'spur', 'stag', 'stone', 'storm', 'strata',
  'stream', 'summit', 'surge', 'swift', 'thorn', 'tide', 'timber', 'tor',
  'torrent', 'tract', 'vale', 'vault', 'vein', 'vent', 'vesper', 'void',
  'wake', 'warbler', 'wave', 'weald', 'well', 'wren', 'yew', 'zenith',
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

export function generatePersonaName(): string {
  return `${pick(adjectives)}-${pick(nouns)}`
}
