const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const FormData = require('form-data');
const retry = require('async-retry');

const app = express();
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

app.use(express.json());

// Initialize p-queue dynamically to handle ESM
let queue;
(async () => {
  const { default: PQueue } = await import('p-queue');
  queue = new PQueue({ concurrency: 1 }); // Process 1 request at a time
})();

// Create public directory
const publicDir = path.join(__dirname, 'public');
fs.ensureDirSync(publicDir);

// Ping endpoint
app.get('/ping', (req, res) => {
  console.log('Recebido ping');
  res.send('Server is alive!');
});

// Function to download file
async function downloadFile(url, filePath) {
  console.log(`Baixando: ${url}`);
  try {
    const response = await retry(
      async () => {
        const res = await axios({
          url,
          method: 'GET',
          responseType: 'stream',
          headers: { 'User-Agent': 'Mozilla/5.0' },
          timeout: 60000, // 60 seconds for large files
          maxRedirects: 5 // Follow redirects
        });
        return res;
      },
      {
        retries: 3,
        factor: 2,
        minTimeout: 1000,
        maxTimeout: 5000,
        onRetry: (err) => console.log(`Retentando download (${url}): ${err.message}`)
      }
    );
    await new Promise((resolve, reject) => {
      response.data.pipe(fs.createWriteStream(filePath))
        .on('finish', resolve)
        .on('error', reject);
    });
    console.log(`Baixado: ${filePath}`);
    const stats = await fs.stat(filePath);
    if (stats.size === 0) throw new Error('Arquivo vazio');
    return filePath;
  } catch (error) {
    console.error(`Erro ao baixar ${url}: ${error.message}`);
    throw error;
  }
}

// Function to get video duration
async function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error(`Erro ao obter duração de ${filePath}: ${err.message}`);
        return reject(err);
      }
      const duration = metadata.format.duration;
      console.log(`Duração do vídeo ${filePath}: ${duration} segundos`);
      resolve(duration);
    });
  });
}

// Function to upload to Google Drive
async function uploadToDrive(filePath, accessToken, folderId) {
  console.log(`Fazendo upload de ${filePath} para o Google Drive, folderId: ${folderId}`);
  try {
    const fileContent = await fs.readFile(filePath);
    const fileSize = (await fs.stat(filePath)).size;
    const metadata = {
      name: path.basename(filePath),
      parents: [folderId],
      mimeType: 'video/mp4'
    };

    // Try multipart upload first
    try {
      const formData = new FormData();
      formData.append('metadata', JSON.stringify(metadata), { contentType: 'application/json' });
      formData.append('file', fileContent, { filename: path.basename(filePath), contentType: 'video/mp4' });
      console.log(`Requisição de upload multipart: URL=https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart, Metadata=${JSON.stringify(metadata)}`);
      const response = await axios.post('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', formData, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          ...formData.getHeaders()
        },
        timeout: 60000,
        maxBodyLength: Infinity // Allow large file uploads
      });
      console.log(`Upload multipart concluído: ${response.data.id}, Pasta: ${folderId}`);
      return response.data.id;
    } catch (multipartError) {
      console.error(`Erro no upload multipart: ${multipartError.message}`);
      if (multipartError.response) {
        console.error(`Detalhes do erro multipart: ${JSON.stringify(multipartError.response.data)}`);
      }

      // Fallback to resumable upload
      console.log('Tentando upload resumível como fallback...');
      const initResponse = await axios.post(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
        metadata,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );
      const uploadUrl = initResponse.headers['location'];
      console.log(`URL de upload resumível obtida: ${uploadUrl}`);

      const response = await axios.put(uploadUrl, fileContent, {
        headers: {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4'
        },
        timeout: 120000, // Increased timeout for large files
        maxBodyLength: Infinity // Ensure no size limit
      });
      console.log(`Upload resumível concluído: ${response.data.id}, Pasta: ${folderId}`);
      return response.data.id;
    }
  } catch (error) {
    console.error(`Erro ao fazer upload para o Drive: ${error.message}`);
    if (error.response) {
      console.error(`Detalhes do erro: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

// Function to clean up temporary files
async function cleanupTempFiles(tempDir, outputPath) {
  try {
    if (await fs.pathExists(tempDir)) {
      await fs.remove(tempDir);
      console.log(`Diretório temporário removido: ${tempDir}`);
    }
    if (outputPath && await fs.pathExists(outputPath)) {
      await fs.remove(outputPath);
      console.log(`Arquivo de saída removido: ${outputPath}`);
    }
  } catch (err) {
    console.error(`Erro ao remover arquivos temporários: ${err.message}`);
  }
}

// Endpoint to generate video
app.post('/generate-video', async (req, res) => {
  if (!queue) {
    return res.status(500).json({ error: 'Queue not initialized' });
  }
  queue.add(async () => {
    const tempDir = path.join(__dirname, 'temp');
    let outputPath = null;
    try {
      const { config, driveAccessToken, driveFolderId, callbackUrl } = req.body;
      if (!config || !config.mediaUrls || !config.outputFile || !driveAccessToken) {
        console.error('Configuração inválida ou parâmetros ausentes');
        return res.status(400).json({ error: 'Configuração inválida ou parâmetros ausentes' });
      }
      if (!driveFolderId || typeof driveFolderId !== 'string' || driveFolderId.trim() === '') {
        console.error('driveFolderId inválido');
        return res.status(400).json({ error: 'driveFolderId inválido' });
      }

      console.log('Configuração recebida:', JSON.stringify(config, null, 2));
      console.log(`driveFolderId recebido: ${driveFolderId}`);
      await fs.ensureDir(tempDir);
      const mediaFiles = [];

      // Download and process media files
      for (let i = 0; i < config.mediaUrls.length; i++) {
        const { url, type, format, duration } = config.mediaUrls[i];
        const extension = type === 'video' ? 'mp4' : (format === 'png' ? 'png' : 'jpg');
        const filePath = path.join(tempDir, `media${i}.${extension}`);

        await downloadFile(url, filePath);

        if (type === 'video') {
          const reencodedPath = path.join(tempDir, `reencoded_media${i}.mp4`);
          await new Promise((resolve, reject) => {
            const command = ffmpeg(filePath)
              .videoCodec('libx264')
              .audioCodec('aac')
              .videoFilters(`scale=${config.resolution || '1280:720'}:force_original_aspect_ratio=decrease,pad=${config.resolution || '1280:720'}:-1:-1:color=black`)
              .outputOptions('-preset ultrafast')
              .output(reencodedPath)
              .on('start', (cmd) => console.log(`Comando FFmpeg (vídeo): ${cmd}`))
              .on('progress', (progress) => console.log(`Progresso FFmpeg (vídeo): ${progress.percent}%`))
              .on('end', resolve)
              .on('error', (err) => reject(new Error(`Erro no FFmpeg (vídeo): ${err.message}`)))
              .run();

            setTimeout(() => {
              command.kill('SIGKILL');
              reject(new Error('Re-codificação FFmpeg timed out after 180 seconds'));
            }, 180000);
          });
          const videoDuration = await getVideoDuration(reencodedPath);
          mediaFiles.push({ filePath: reencodedPath, type, duration: videoDuration });
        } else {
          const scaledPath = path.join(tempDir, `scaled_media${i}.${extension}`);
          await new Promise((resolve, reject) => {
            const command = ffmpeg(filePath)
              .videoFilters(`scale=${config.resolution || '1280:720'}:force_original_aspect_ratio=decrease,pad=${config.resolution || '1280:720'}:-1:-1:color=black`)
              .outputOptions('-preset ultrafast')
              .output(scaledPath)
              .on('start', (cmd) => console.log(`Comando FFmpeg (imagem): ${cmd}`))
              .on('progress', (progress) => console.log(`Progresso FFmpeg (imagem): ${progress.percent}%`))
              .on('end', resolve)
              .on('error', (err) => reject(new Error(`Erro no FFmpeg (imagem): ${err.message}`)))
              .run();

            setTimeout(() => {
              command.kill('SIGKILL');
              reject(new Error('Escalonamento FFmpeg timed out after 30 seconds'));
            }, 30000);
          });
          mediaFiles.push({ filePath: scaledPath, type, duration });
        }
      }

      // Download audio if provided
      let audioFile;
      if (config.audioUrl && config.audioUrl.trim() !== '') {
        audioFile = path.join(tempDir, 'audio.mp3');
        await downloadFile(config.audioUrl, audioFile);
      }

      // Create FFmpeg input file
      const inputFileList = path.join(tempDir, 'input.txt');
      const inputContent = mediaFiles.map(({ filePath, type, duration }) => {
        if (type === 'image') {
          return `file '${filePath}'\nduration ${duration}`;
        }
        return `file '${filePath}'`;
      }).join('\n');
      await fs.writeFile(inputFileList, inputContent);
      console.log('Arquivo de entrada criado:', inputFileList);

      // Generate video
      outputPath = path.join(publicDir, config.outputFile);
      await new Promise((resolve, reject) => {
        const command = ffmpeg()
          .input(inputFileList)
          .inputOptions(['-f concat', '-safe 0']);
        if (audioFile) {
          command.input(audioFile);
        }
        command
          .videoCodec('libx264')
          .audioCodec('aac')
          .outputOptions([
            `-s ${config.resolution || '1280:720'}`,
            '-pix_fmt yuv420p',
            '-preset ultrafast',
            '-crf 23'
          ])
          .output(outputPath)
          .on('start', (cmd) => console.log(`Comando FFmpeg (vídeo final): ${cmd}`))
          .on('progress', (progress) => console.log(`Progresso FFmpeg (vídeo final): ${progress.percent}%`))
          .on('end', resolve)
          .on('error', (err) => reject(new Error(`Erro no FFmpeg (vídeo final): ${err.message}`)))
          .run();

        setTimeout(() => {
          command.kill('SIGKILL');
          reject(new Error('FFmpeg timed out after 300 seconds'));
        }, 300000);
      });
      console.log('Vídeo gerado:', outputPath);

      // Upload to Google Drive
      const driveFileId = await uploadToDrive(outputPath, driveAccessToken, driveFolderId);
      const driveFileUrl = `https://drive.google.com/file/d/${driveFileId}/view`;

      // Send callback to GAS
      if (callbackUrl) {
        console.log(`Enviando callback para: ${callbackUrl}`);
        try {
          const response = await axios.post(callbackUrl, {
            configId: config.configId,
            driveFileId,
            driveFileUrl
          }, {
            timeout: 300000
          });
          console.log('Callback enviado. Resposta:', response.data);
        } catch (error) {
          console.error(`Erro ao enviar callback: ${error.message}`);
          if (error.response) {
            console.error('Detalhes do erro:', error.response.data);
          }
        }
      }

      // Clean up temporary files
      await cleanupTempFiles(tempDir, outputPath);
      res.json({ success: true, driveFileId, driveFileUrl });
    } catch (error) {
      console.error('Erro no generate-video:', error.message);
      await cleanupTempFiles(tempDir, outputPath);
      res.status(500).json({ error: error.message });
    }
  }).then(() => {}).catch(err => {
    console.error('Erro na fila:', err.message);
    res.status(500).json({ error: err.message });
  });
});

// Serve static files
app.use('/public', express.static(publicDir));

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port', process.env.PORT || 3000);
});
