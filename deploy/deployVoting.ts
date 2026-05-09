import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const result = await deploy("ConfidentialVoting", {
    from: deployer,
    log: true,
  });

  console.log("ConfidentialVoting deployed at:", result.address);
  console.log(`Etherscan: https://sepolia.etherscan.io/address/${result.address}`);
};

export default func;
func.id = "deploy_confidential_voting";
func.tags = ["ConfidentialVoting"];
