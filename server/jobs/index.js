const chokidar = require('chokidar');
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const { getMovieMetaData, getTVShowMetaData, getAlbumMetaData } = require('../models');
const { Type } = require('../constants');
var fileSystem = [];
var ready;

if (new Set([process.env.MOVIES_PATH, process.env.TV_PATH, process.env.MUSIC_PATH]).size != 3) {
  throw "Each media must be in a unique location and cannot share the same directory path(s)" 
}

var watcher = chokidar.watch([process.env.MOVIES_PATH, process.env.TV_PATH, process.env.MUSIC_PATH], {
  ignored: /(^|[\/\\])\../, // ignore dotfiles
  persistent: true
});

watcher.on('ready', () => {
  console.log('Initial scan complete. Ready for changes')
  ready = true;
  collection = watcher.getWatched()
  ready && sync()
})

watcher
  .on('add', path => {
    console.log(`File ${path} has been added`)
    fileSystem.push(path)
    ready && sync()
  })
  .on('change', path => {
    console.log(`File ${path} has been changed`)
  })
  .on('unlink', path => {
    console.log(`File ${path} has been removed`)
    fileSystem = fileSystem.filter(e => e !== path)
    ready && sync()
  })

const sync = async () => {

  const notAvailableFiles = await getNotAvailableFiles()
  console.log(`notAvailable is ${notAvailableFiles.length}`)
  console.table(notAvailableFiles)

  const databaseFiles = await getAllFiles()
  const filesToInsert = fileSystem.filter(x => !databaseFiles.includes(x))
                        .filter(x => !notAvailableFiles.includes(x))
  const intersection = databaseFiles.filter(x => fileSystem.includes(x))
  const filesToDelete = databaseFiles.concat(notAvailableFiles)
                        .filter(x => !fileSystem.includes(x))

  console.log(`intersection is ${intersection.length}`)
  console.log(`exclusiveToFileSystem is ${filesToInsert.length}`)
  console.table(filesToInsert)
  console.log(`exclusiveToDatabase is ${filesToDelete.length}`)
  console.table(filesToDelete)

  // insert to db
  filesToInsert.length && await upsertManyMovies(filesToInsert.filter(file => file.startsWith(process.env.MOVIES_PATH)))
  filesToInsert.length && await upsertManyTVEpisodes(filesToInsert.filter(file => file.startsWith(process.env.TV_PATH)))
  filesToInsert.length && await upsertManySongs(filesToInsert.filter(file => file.startsWith(process.env.MUSIC_PATH)))

  // delete from db
  filesToDelete.length && await deleteManyNotAvailable(filesToDelete)
  filesToDelete.length && await deleteManyMovies(filesToDelete.filter(file => file.startsWith(process.env.MOVIES_PATH)))
  filesToDelete.length && await deleteManyTVEpisodes(filesToDelete.filter(file => file.startsWith(process.env.TV_PATH)))
  filesToDelete.length && await deleteManySongs(filesToDelete.filter(file => file.startsWith(process.env.MUSIC_PATH)))
}

const upsertAll = async (media = ["movies", "tv", "music"]) => {
  let jobs = []
  for (let type of media) {
    if (type == "movies") jobs.push(await upsertManyMovies(fileSystem.filter(file => file.startsWith(process.env.MOVIES_PATH))))
    if (type == "tv") jobs.push(await upsertManyTVEpisodes(fileSystem.filter(file => file.startsWith(process.env.TV_PATH))))
    if (type == "music") jobs.push(await upsertManySongs(fileSystem.filter(file => file.startsWith(process.env.MUSIC_PATH))))
  }
  return jobs
}

const upsertManyMovies = async (movies) => {
  console.log('Generating data for Movies...')

  for (let file of movies){
    try {
      let result = await getMovieMetaData(file);
      if (result.status == 400) {
        upsertNotAvailable(Type.Movie, result.fs_path)
        continue;
      }

      const movie = {
        ...result,
        genres: {
          connectOrCreate: result.genres.map(g => ({
            create: g,
            where: { tmdb_id: g.tmdb_id },
          }))
        },
        production_companies: {
          connectOrCreate: result.production_companies.map(p => ({
            create: p,
            where: { tmdb_id: p.tmdb_id },
          }))
        },
        credits: {
          connectOrCreate: result.credits.map(c => ({
            create: c,
            where: { credit_id: c.credit_id },
          }))
        },
        similar: {
          connectOrCreate: result.similar.map(s => ({
            create: s,
            where: { tmdb_id: s.tmdb_id },
          }))
        }
      }
    
      await prisma.movie.upsert({
        where: { tmdb_id: result.tmdb_id },
        update: movie,
        create: movie
      })

    } catch(e) {
      console.log("There was a problem adding this movie", e)
      break; // break or continue
    }
  }
  console.log('[MOVIES] Done')
}

const upsertManyTVEpisodes = async (episodes) => {
  console.log('Generating data for TV...')

  for (let file of episodes){
    try {
      let result = await getTVShowMetaData(file)
      if (result.status == 400) {
        upsertNotAvailable(Type.TV.Episode, result.fs_path)
        continue;
      }

      const seasons = result.seasons.map(s => {
        return {
          ...s,
          episodes: {
            connectOrCreate: s.episodes.map(e => ({
              create: e,
              where: { tmdb_id: e.tmdb_id }
            }))
          },
          tv_show: { connect: { tmdb_id : result.tmdb_id }}
        }
      })

      delete result.created_by
      delete result.seasons

      const tv_show = {
        ...result,
        genres: {
          connectOrCreate: result.genres.map(g => ({
            create: g,
            where: { tmdb_id: g.tmdb_id },
          }))
        },
        production_companies: {
          connectOrCreate: result.production_companies.map(p => ({
            create: p,
            where: { tmdb_id: p.tmdb_id },
          }))
        },
        credits: {
          connectOrCreate: result.credits.map(c => ({
            create: c,
            where: { credit_id: c.credit_id },
          }))
        },
        similar: {
          connectOrCreate: result.similar.map(s => ({
            create: s,
            where: { tmdb_id: s.tmdb_id },
          }))
        }
      }

      await prisma.tVShow.upsert({
        where: { tmdb_id: result.tmdb_id },
        update: tv_show,
        create: tv_show
      })

      for (var s of seasons) {
        await prisma.season.upsert({
          where: { tmdb_id: s.tmdb_id },
          update: s,
          create: s
        })
      }

    } catch(e) {
      console.log("There was a problem adding this episode", e)
      break; // break or continue
    }
  }
  console.log('[TV] Done')
}

const upsertManySongs = async (songs) => {
  console.log('Generating data for Music...')

  for (let file of songs) {
    try {
      let result = await getAlbumMetaData(file)
      if (result.status == 400) {
        upsertNotAvailable(Type.Music.Song, result.fs_path)
        continue;
      }

      const album = {
        ...result,
        artists: {
          connectOrCreate: result.artists.map(a => ({
            create: a,
            where: { spotify_id: a.spotify_id }
          }))
        },
        songs: {
          connectOrCreate: result.songs.map(s => ({
            create: s,
            where: { spotify_id: s.spotify_id }
          }))
        }
      }
      
      await prisma.album.upsert({
        where: { spotify_id: result.spotify_id },
        update: album,
        create: album
      })

    } catch(e) {
      console.log("There was a problem adding this song", e)
      break; // break or continue
    }
  }
  console.log('[MUSIC] Done')
}

const upsertNotAvailable = async (type, file) => {
  const not_available = { type: type, fs_path: file }
  await prisma.notAvailable.upsert({
    where: { fs_path: file },
    update: not_available,
    create: not_available
  })
  console.log('[NOT AVAILABLE] Done')
}

const getAllFiles = async () => {
  var movies = await prisma.movie.findMany({
    select: { fs_path: true }
  })
  var episodes = await prisma.episode.findMany({
    select: { fs_path: true }
  })
  var songs = await prisma.song.findMany({
    select: { fs_path: true }
  })
  return [].concat(movies).concat(episodes).concat(songs).map(Object.values).flat(Infinity)
}

const getNotAvailableFiles = async () => {
  var result = await prisma.notAvailable.findMany({
    select: { fs_path: true }
  })
  return result.map(Object.values).flat(Infinity)
}

const getNotAvailable = async () => {
  const result = await prisma.notAvailable.findMany()
  return result
}

const deleteManyNotAvailable = async (not_available) => {
  for (let file of not_available){
    try {
      await prisma.notAvailable.delete({
        where: {
          fs_path: file
        }
      })
    } catch(e) {
      console.log("There was a problem removing this file")
      continue; // break or continue
    }
  }
  console.log('[NOT AVAILABLE] Done')
}

const deleteManyMovies = async (movies) => {
  for (let file of movies){
    try {
      await prisma.movie.delete({
        where: {
          fs_path: file
        }
      })
    } catch(e) {
      console.log("There was a problem removing this movie")
      continue; // break or continue
    }
  }
  console.log('[MOVIES] Done')
}

const deleteManyTVEpisodes = async (episodes) => {
  for (let file of episodes){
    try {
      await prisma.episode.delete({
        where: {
          fs_path: file
        }
      })
    } catch(e) {
      console.log("There was a problem removing this episode")
      continue; // break or continue
    }
  }
  console.log('[TV] Done')
}

const deleteManySongs = async (songs) => {
  for (let file of songs){
    try {
      await prisma.song.delete({
        where: {
          fs_path: file
        }
      })
    } catch(e) {
      console.log("There was a problem removing this song")
      continue; // break or continue
    }
  }
  console.log('[MUSIC] Done')
}

module.exports = { upsertAll, getNotAvailable }