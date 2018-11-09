import { join } from "path";
import { createReadStream, createWriteStream } from "fs";
import { getJpegExifFilter } from "./jpeg-app-filter-stream";
import { Transform, TransformCallback, Duplex } from "stream";


const log = console.log.bind(console);


const source = createReadStream(  join(`C:/Users/wfide/AppData/Local/Temp/hugeTmpFile` ), {
    // highWaterMark: 10
});


// const source = createReadStream(  join(__dirname, `../../assets/jpg-thexifer.net.jpg`), {
//     highWaterMark: 200
// });



// const filter = getJpegExifFilter({
//     highWaterMark: 10
// });



const destination = createWriteStream( join(`C:/Users/wfide/AppData/Local/Temp/hugeTmpFile_OUTPUT` ) );


// const destination = new Writable({
//     // highWaterMark: hwm.destination,
//     write(chunk, _enc, callback) {
//         // output.push(chunk);
//         // setTimeout( callback, 0 );
//         callback();
//     }
// });



class CustomFilter extends Duplex {


    private data = Buffer.from("");

    private writeBufferReady = true;
    private readBufferReady = true;
    private lastWriteCallack = this.empty;
    private processingData = false;



    _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void {
        log(`     _write ${chunk.length}  and  ${this.readBufferReady ? "process" : "wait"}`);
        this.data = Buffer.concat([this.data, chunk], this.data.length + chunk.length);

        this.lastWriteCallack = callback;

        if (this.readBufferReady) {
            this.processData();
        }

    }



    _read(size: number) {
        log(`     _read  (${size})`);
        this.readBufferReady = true;
        this.processData();
    }



    processData() {
        log(`        Data processing ${this.processingData ? "already in progress (ignore)" : "start"}`)


        if ( ! this.processingData) {
            this.processingData = true;

            let enoughDataToProcess = this.data.length > 0;
            while (this.readBufferReady && enoughDataToProcess) {

                let chunk = this.getChunk();

                // This may trigger this.read() or this.write()  (depends on situation)
                log(`        pushing... ${chunk.length}`);
                this.readBufferReady = this.push( chunk );
                log(`        ....pushed`);

                enoughDataToProcess = this.data.length > 0;
            }


            this.writeBufferReady = this.data.length < this.writableHighWaterMark;
            log(`        write buffer ${this.writeBufferReady ? "ready" : "full"}`);

            if (this.writeBufferReady) {
                log(`        signaling data processed...`);
                // this.lastWriteCallback() may cause this.write() or this.read() depends on situation
                // so this.lastWriteCallback may be overwritten afterward
                let writeCallback = this.lastWriteCallack;
                this.lastWriteCallack = this.empty;
                writeCallback();
                log(`        ...data processed signaled`);
            }

            log(`        Data processing END`);

            this.processingData = false;
        }

    }



    getChunk() {
        let chunk;

        if (this.data.length > 10) {
            let halfLength = Math.floor(this.data.length/2);
            chunk = this.data.slice(0, halfLength);
            this.data = this.data.slice(halfLength);
        }
        else {
            chunk = this.data;
            this.data = Buffer.from("");
        }

        return chunk;
    }



    empty() {
        // Nothig to do
    }

}



const customFilter = new CustomFilter({
    // highWaterMark: 200
});


const preTransform = new Transform ({
    transform(chunk: any, _encoding: string, callback: TransformCallback) {
        log(`  sending ${chunk.length}`);
        // setTimeout( () => {
            callback(undefined, chunk);
            log(`  sent`);
        // }, 0);
    },
    // highWaterMark: 100
});

const postTransform = new Transform ({
    transform(chunk: any, _encoding: string, callback: TransformCallback) {
        log(`            consuming ${chunk.length}`);
        // setTimeout( () => {
            callback(undefined, chunk)
            log(`            data consumed ${chunk.length}`);
        // }, 100);
    },
    // highWaterMark: 200
});

source
    .pipe( preTransform )
    .pipe( customFilter )
    .pipe( postTransform )
    .pipe( destination );


destination.on("finish", function() {
    log("DONE");
})
