// server.js
import express from "express";
import { createWriteStream, writeFileSync, readFileSync } from "fs";
import { exec } from "child_process";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "200mb" }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // must be set in Railway env
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PORT = process.env.PORT || 3000;
const OUTPUT_BUCKET = process.env.OUTPUT_BUCKET || "outputs";

function runCommand(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { ...opts, maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

app.post("/api/process", async (req, res) => {
  try {
    const { job_id, user_id, files, options } = req.body;
    if (!job_id || !user_id || !files || !files.length) {
      return res.status(400).json({ error: "job_id, user_id and files[] are required" });
    }

    const jobDir = path.join(os.tmpdir(), `job-${uuidv4()}`);
    await import("fs").then(fs => fs.mkdirSync(jobDir, { recursive: true }));

    const localPaths = [];
    // Download each file (expects files[i].signedUrl)
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const url = f.signedUrl || f.url;
      if (!url) throw new Error("Each file needs a signedUrl or url");

      const localPath = path.join(jobDir, `clip-${i}.mp4`);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to download ${url}: ${resp.status}`);
      const stream = createWriteStream(localPath);
      await new Promise((resolve, reject) => {
        resp.body.pipe(stream);
        resp.body.on("error", reject);
        stream.on("finish", resolve);
      });
      localPaths.push(localPath);
    }

    // Build ffmpeg concat list
    const listTxt = localPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
    const listPath = path.join(jobDir, "videos.txt");
    writeFileSync(listPath, listTxt);

    const outputPath = path.join(jobDir, "output.mp4");

    // Use re-encode to ensure compatibility
    const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outputPath}"`;
    await runCommand(ffmpegCmd, { cwd: jobDir });

    // Upload result to Supabase outputs bucket
    const outputFileName = `${user_id}/${job_id}-final.mp4`; // store inside 'outputs' bucket
    const fileBuffer = readFileSync(outputPath);

    const { data: uploadData, error: uploadError } = await supabase.storage
      .from(OUTPUT_BUCKET)
      .upload(outputFileName, fileBuffer, { contentType: "video/mp4", upsert: true });

    if (uploadError) throw uploadError;

    // Create signed URL for the processed file (24h)
    const { data: urlData, error: urlError } = await supabase.storage
      .from(OUTPUT_BUCKET)
      .createSignedUrl(outputFileName, 60 * 60 * 24);

    if (urlError) throw urlError;
    const outputUrl = urlData.signedUrl;

    // Update videos table
    await supabase
      .from("videos")
      .update({ status: "done", output_url: outputUrl, updated_at: new Date().toISOString() })
      .eq("id", job_id);

    res.json({ job_id, status: "done", outputUrl });
  } catch (err) {
    console.error("Processing error:", err);
    // best-effort update to DB
    if (req.body?.job_id) {
      try {
        await supabase.from("videos").update({ status: "failed", error_message: String(err) }).eq("id", req.body.job_id);
      } catch (e) {
        console.error("Failed to update videos table:", e);
      }
    }
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/status/:job_id", async (req, res) => {
  const jobId = req.params.job_id;
  try {
    const { data, error } = await supabase.from("videos").select("id,status,output_url,error_message,updated_at").eq("id", jobId).single();
    if (error) return res.status(404).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => console.log(`Video processor listening on ${PORT}`));
