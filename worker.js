import 'dotenv/config';
import { createClient } from "@supabase/supabase-js";
import { exec } from "child_process";
import fs from "fs";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// 🔹 Poll every 30s
setInterval(async () => {
  console.log("Checking for video jobs...");

  const { data: jobs, error } = await supabase
    .from("videos")
    .select("*")
    .eq("status", "processing")
    .limit(1);

  if (error) {
    console.error("Error fetching jobs:", error);
    return;
  }

  if (!jobs || jobs.length === 0) {
    console.log("No jobs found.");
    return;
  }

  const job = jobs[0];
  console.log("Processing job:", job.id);

  try {
    // Download input files
    const inputPaths = [];
    for (let i = 0; i < job.input_files.length; i++) {
      const url = job.input_files[i];
      const res = await fetch(url);
      const filePath = path.join(__dirname, `input${i}.mp4`);
      const fileStream = fs.createWriteStream(filePath);
      await new Promise((resolve, reject) => {
        res.body.pipe(fileStream);
        res.body.on("error", reject);
        fileStream.on("finish", resolve);
      });
      inputPaths.push(filePath);
    }

    // Combine with FFmpeg
    const listFile = path.join(__dirname, "inputs.txt");
    fs.writeFileSync(
      listFile,
      inputPaths.map((p) => `file '${p}'`).join("\n")
    );

    const outputFile = path.join(__dirname, `output-${job.id}.mp4`);
    const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputFile}"`;

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (err, stdout, stderr) => {
        if (err) {
          console.error("FFmpeg error:", stderr);
          reject(err);
        } else {
          resolve();
        }
      });
    });

    // Upload output file
    const fileBuffer = fs.readFileSync(outputFile);
    const { data: storageData, error: storageError } =
      await supabase.storage
        .from("videos")
        .upload(`outputs/${job.id}.mp4`, fileBuffer, {
          contentType: "video/mp4",
          upsert: true,
        });

    if (storageError) throw storageError;

    const { data: publicUrlData } = supabase.storage
      .from("videos")
      .getPublicUrl(`outputs/${job.id}.mp4`);

    // Update job record
    await supabase
      .from("videos")
      .update({
        status: "completed",
        output_url: publicUrlData.publicUrl,
      })
      .eq("id", job.id);

    console.log("Job completed:", job.id);
  } catch (err) {
    console.error("Job failed:", err);
    await supabase
      .from("videos")
      .update({
        status: "failed",
        error_message: err.message,
      })
      .eq("id", job.id);
  }
}, 30000);
