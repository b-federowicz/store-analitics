import { Button } from "./button";


export function DownloadButton({data, downloadName}: {data: string[], downloadName: string}) {

    const downloadFile = () => {
        const text = data.join("\n");

        const blob = new Blob([text], { type: "text/plain" });

        const url = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.href = url;
        link.download = downloadName;

        document.body.appendChild(link);
        link.click();

        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    return (
        <Button onClick={downloadFile} variant="outline">
            Download
        </Button>
    )
}