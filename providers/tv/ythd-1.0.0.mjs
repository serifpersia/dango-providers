export default function createProvider() {
  async function getEmbedUrl(media) {
    const id = Number(media.tmdbId)
    if (!id) return null
    if (media.type === 'movie') return `https://ythd.org/embed/${id}`
    return `https://ythd.org/embed/${id}/${media.season || 1}-${media.episode || 1}`
  }

  return { name: 'ythd', getEmbedUrl }
}
